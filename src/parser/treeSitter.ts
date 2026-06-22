import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { GraphNode, GraphEdge } from '../graph/schema';

export interface ParseResult {
  fileNode: GraphNode;
  symbolNodes: GraphNode[];
  edges: GraphEdge[];
}

export class CodeParser {
  parseFile(filePath: string, content: string, workspaceRoot: string): ParseResult {
    const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
    const hash = sha256(content);
    const now = Date.now();

    // Read path aliases from tsconfig once
    const aliases = readPathAliases(workspaceRoot);
    const imports = extractImports(content, relativePath, workspaceRoot, aliases);
    const symbols = extractSymbols(content, relativePath, hash, now);

    const fileNode: GraphNode = {
      id: relativePath,
      kind: 'file',
        lineCount: content.split('\n').length,
      path: relativePath,
      name: path.basename(filePath),
      description: '',
      tags: [],
      exported: true,
      lastHash: hash,
      lastUpdated: now,
    };

    const edges: GraphEdge[] = [];

    for (const imp of imports) {
      edges.push({
        id: edgeId(relativePath, 'imports', imp.resolvedPath),
        from: relativePath,
        to: imp.resolvedPath,
        kind: 'imports',
        weight: 1,
      });
    }

    for (const sym of symbols) {
      if (sym.exported) {
        edges.push({
          id: edgeId(relativePath, 'exports', sym.id),
          from: relativePath,
          to: sym.id,
          kind: 'exports',
          weight: 1,
        });
      }
    }

    return { fileNode, symbolNodes: symbols, edges };
  }
}

// ─── Path alias cache ─────────────────────────────────────────────────────────

const aliasCache = new Map<string, Record<string, string>>();

function readPathAliases(workspaceRoot: string): Record<string, string> {
  if (aliasCache.has(workspaceRoot)) return aliasCache.get(workspaceRoot)!;

  const result: Record<string, string> = {
    // Default Next.js / Vite convention
    '@/': './',
    '~/': './',
  };

  try {
    const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
      const raw = fs.readFileSync(tsconfigPath, 'utf8')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const tsconfig = JSON.parse(raw);
      const paths = tsconfig.compilerOptions?.paths ?? {};
      const baseUrl = tsconfig.compilerOptions?.baseUrl ?? '.';

      for (const [alias, targets] of Object.entries(paths) as [string, string[]][]) {
        if (targets.length > 0) {
          // "@/*": ["./src/*"]  →  "@/" : "src/"
          const cleanAlias = alias.replace(/\*$/, '');
          const cleanTarget = (targets[0] as string)
            .replace(/\*$/, '')
            .replace(/^\.\//, '');
          result[cleanAlias] = cleanTarget || './';
        }
      }
    }
  } catch { /* use defaults */ }

  aliasCache.set(workspaceRoot, result);
  return result;
}

// ─── Import extraction ────────────────────────────────────────────────────────

interface ImportInfo {
  source: string;
  resolvedPath: string;
}

function extractImports(
  content: string,
  fromFile: string,
  workspaceRoot: string,
  aliases: Record<string, string>
): ImportInfo[] {
  const results: ImportInfo[] = [];
  const fromDir = path.dirname(fromFile);

  const patterns = [
    /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /export\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const source = match[1];

      // Relative import: ./foo or ../foo
      if (source.startsWith('.')) {
        const resolved = resolveRelative(fromDir, source);
        if (resolved) results.push({ source, resolvedPath: resolved });
        continue;
      }

      // Path alias: @/foo, ~/foo, or custom from tsconfig
      const aliasMatch = Object.entries(aliases).find(([prefix]) => source.startsWith(prefix));
      if (aliasMatch) {
        const [prefix, target] = aliasMatch;
        const rest = source.slice(prefix.length);
        const resolved = normalizeExt(`${target}${rest}`).replace(/^\.\//, '');
        results.push({ source, resolvedPath: resolved });
        continue;
      }

      // Everything else is node_modules -- skip
    }
  }

  // Deduplicate by resolvedPath
  const seen = new Set<string>();
  return results.filter(r => {
    if (seen.has(r.resolvedPath)) return false;
    seen.add(r.resolvedPath);
    return true;
  });
}

function resolveRelative(fromDir: string, importPath: string): string | null {
  const base = path.join(fromDir, importPath).replace(/\\/g, '/');
  return normalizeExt(base);
}

function normalizeExt(base: string): string {
  // If already has an explicit extension, use as-is
  if (/\.\w{1,4}$/.test(base)) return base;
  // Leave bare -- resolveEdges() in the store will match to the actual file
  return base;
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractSymbols(content: string, filePath: string, hash: string, now: number): GraphNode[] {
  const symbols: GraphNode[] = [];
  const lines = content.split('\n');

  const patterns: Array<{
    regex: RegExp;
    kind: GraphNode['kind'];
    nameGroup: number;
    sigFn: (m: RegExpMatchArray) => string;
  }> = [
    {
      regex: /^(export\s+)?(async\s+)?function\s+(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*([^{]+))?/,
      kind: 'function', nameGroup: 3,
      sigFn: m => `function ${m[3]}(${m[5] || ''}): ${(m[6] || 'void').trim()}`,
    },
    {
      regex: /^(export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*([^=>{]+))?\s*=>/,
      kind: 'function', nameGroup: 2,
      sigFn: m => `const ${m[2]} = (${m[3] || ''}) => ${(m[4] || 'unknown').trim()}`,
    },
    {
      regex: /^(export\s+)?(abstract\s+)?class\s+(\w+)(\s+extends\s+\w+)?(\s+implements\s+[\w,\s]+)?/,
      kind: 'class', nameGroup: 3,
      sigFn: m => `class ${m[3]}${m[4] || ''}${m[5] || ''}`,
    },
    {
      regex: /^(export\s+)?interface\s+(\w+)(\s+extends\s+[\w,\s]+)?/,
      kind: 'interface', nameGroup: 2,
      sigFn: m => `interface ${m[2]}${m[3] || ''}`,
    },
    {
      regex: /^(export\s+)?type\s+(\w+)(\s*<[^>]*>)?\s*=/,
      kind: 'type', nameGroup: 2,
      sigFn: m => `type ${m[2]}${m[3] || ''}`,
    },
    {
      regex: /^(export\s+)?const\s+([A-Z_][A-Z0-9_]{2,})\s*=/,
      kind: 'constant', nameGroup: 2,
      sigFn: m => `const ${m[2]}`,
    },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    for (const { regex, kind, nameGroup, sigFn } of patterns) {
      const match = line.match(regex);
      if (!match) continue;
      const name = match[nameGroup];
      if (!name || name.length < 2) continue;
      const id = `${filePath}::${name}`;
      if (symbols.some(s => s.id === id)) continue;
      symbols.push({
        id, kind, path: filePath, name,
        description: '', signature: sigFn(match),
        tags: [], exported: !!match[1]?.includes('export'),
        lineStart: i + 1, lineEnd: i + 1,
        lastHash: hash, lastUpdated: now,
      });
    }
  }

  return symbols;
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

function edgeId(from: string, kind: string, to: string): string {
  return `${from}::${kind}::${to}`;
}

export const parser = new CodeParser();
