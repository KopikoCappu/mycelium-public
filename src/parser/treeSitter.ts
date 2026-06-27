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

// ─── Language-specific raw path extractors ────────────────────────────────────
// Each returns raw path strings. Relative-path resolution happens in extractImports().

function extractJsRawPaths(content: string): string[] {
  const paths: string[] = [];
  const patterns = [
    /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /export\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
  ];
  for (const p of patterns) {
    let m: RegExpExecArray | null;
    while ((m = p.exec(content)) !== null) paths.push(m[1]);
  }
  return paths;
}

function extractHtmlRawPaths(content: string): string[] {
  const paths: string[] = [];

  // <script src="path.js"> or <script src='path.js'>
  for (const m of content.matchAll(/<script[^>]+\bsrc=["']([^"']+)["']/gi)) {
    const p = m[1].trim();
    if (!p.startsWith('http') && !p.startsWith('//') && !p.startsWith('#'))
      // Prefix ./ so the resolver treats it as relative even without an explicit dot
      paths.push(p.startsWith('.') ? p : './' + p);
  }

  // <link href="styles.css"> — only grab stylesheet/preload hrefs, not navigation
  for (const m of content.matchAll(/<link[^>]+\bhref=["']([^"'#?]+)["']/gi)) {
    const p = m[1].trim();
    // Only local CSS/JS assets (skip http, //, data:, mailto:)
    if (!p.startsWith('http') && !p.startsWith('//') && !p.startsWith('data:')) {
      if (/\.(css|js|mjs)$/.test(p))
        paths.push(p.startsWith('.') ? p : './' + p);
    }
  }

  // Inline <script type="module"> — pick up ES import statements inside
  for (const block of content.matchAll(
    /<script[^>]+type=["']module["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    paths.push(...extractJsRawPaths(block[1]));
  }

  return paths;
}

function extractCssRawPaths(content: string): string[] {
  const paths: string[] = [];

  // @import "path", @import url("path")
  // @use "path" (SCSS), @forward "path" (SCSS)
  for (const m of content.matchAll(
    /^\s*@(?:import|use|forward)\s+(?:url\()?["']([^"')]+)["']/gm
  )) {
    const p = m[1].trim();
    if (!p.startsWith('http') && !p.startsWith('//'))
      paths.push(p.startsWith('.') ? p : './' + p);
  }

  return paths;
}

function extractPythonRawPaths(content: string): string[] {
  const paths: string[] = [];

  // from .module.submodule import x  (relative import with named module)
  for (const m of content.matchAll(/^from\s+(\.+)([\w.]+)\s+import\s+/gm)) {
    const dots = m[1];
    const mod  = m[2].replace(/\./g, '/');   // utils.helpers → utils/helpers
    const prefix = dots.length === 1 ? './' : '../'.repeat(dots.length - 1);
    paths.push(prefix + mod);
  }

  // from . import name1, name2  (import names from current package)
  for (const m of content.matchAll(/^from\s+(\.+)\s+import\s+([\w,\s]+)/gm)) {
    const dots  = m[1];
    const names = m[2].split(',').map(n => n.trim()).filter(Boolean);
    const prefix = dots.length === 1 ? './' : '../'.repeat(dots.length - 1);
    for (const name of names) paths.push(prefix + name);
  }

  // Absolute imports (e.g. import os, import mypackage.utils) are skipped:
  // we can't reliably distinguish stdlib from local packages without analysing
  // the project structure. Add go.mod / pyproject.toml parsing later if needed.

  return paths;
}

function extractRustRawPaths(content: string): string[] {
  const paths: string[] = [];

  // mod submodule;  (includes ./submodule.rs or ./submodule/mod.rs)
  for (const m of content.matchAll(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm)) {
    paths.push('./' + m[1]);
  }

  // use super::module  →  ../module
  for (const m of content.matchAll(/^\s*use\s+super::([\w:]+)/gm)) {
    const p = m[1].split('::')[0];   // take the first segment only
    paths.push('../' + p);
  }

  // use crate::path::to::module  →  path/to/module  (crate-root relative)
  // We store these without the leading ./ — resolveNodeId will find them.
  for (const m of content.matchAll(/^\s*use\s+crate::([\w:]+)/gm)) {
    const p = m[1]
      .replace(/\{[^}]*\}$/, '')   // strip trailing { ... }
      .split('::')
      .filter(Boolean)
      .join('/');
    if (p) paths.push(p);
  }

  // External crates (e.g. "use serde::Serialize") are skipped.

  return paths;
}

function extractCppRawPaths(content: string): string[] {
  const paths: string[] = [];

  // #include "local_header.h"  — quoted = project-local
  for (const m of content.matchAll(/^\s*#include\s+"([^"]+)"/gm)) {
    const p = m[1].replace(/^\.\//, '');   // normalise any existing ./
    paths.push('./' + p);
  }

  // #include <system.h>  — angle brackets = system / third-party, skip

  return paths;
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
  const ext     = path.extname(fromFile).toLowerCase();

  // ── Dispatch to the right extractor ──────────────────────────────────────
  let rawPaths: string[];
  switch (ext) {
    case '.html': case '.htm': case '.xhtml':
      rawPaths = extractHtmlRawPaths(content);
      break;
    case '.css': case '.scss': case '.sass': case '.less':
      rawPaths = extractCssRawPaths(content);
      break;
    case '.py': case '.pyi':
      rawPaths = extractPythonRawPaths(content);
      break;
    case '.rs':
      rawPaths = extractRustRawPaths(content);
      break;
    case '.c': case '.cpp': case '.cc': case '.cxx':
    case '.h': case '.hpp': case '.hh': case '.hxx':
      rawPaths = extractCppRawPaths(content);
      break;
    // Go: skipped for now — local vs external package is indistinguishable
    // without parsing go.mod. Add go.mod-aware resolution when needed.
    default:
      rawPaths = extractJsRawPaths(content);
      break;
  }

  // ── Resolve each raw path to a graph node ID ──────────────────────────────
  for (const source of rawPaths) {
    if (!source) continue;

    // Skip URLs, protocol-relative, anchors, data URIs
    if (
      source.startsWith('http') ||
      source.startsWith('//') ||
      source.startsWith('#') ||
      source.startsWith('data:') ||
      source.startsWith('mailto:')
    ) continue;

    // ── Relative path (starts with . or ../) ──────────────────────────────
    if (source.startsWith('.')) {
      const resolved = resolveRelative(fromDir, source);
      if (resolved) results.push({ source, resolvedPath: resolved });
      continue;
    }

    // ── TS/JS path alias: @/foo, ~/foo, custom tsconfig paths ─────────────
    const aliasMatch = Object.entries(aliases).find(([prefix]) => source.startsWith(prefix));
    if (aliasMatch) {
      const [prefix, target] = aliasMatch;
      const rest     = source.slice(prefix.length);
      const resolved = normalizeExt(`${target}${rest}`).replace(/^\.\//, '');
      results.push({ source, resolvedPath: resolved });
      continue;
    }

    // ── Rust crate-root paths (no leading ./ from crate::) ────────────────
    // These look like "src/utils/auth" — pass through as-is;
    // resolveNodeId() in the store will try adding extensions.
    if (ext === '.rs' && !source.startsWith('.')) {
      results.push({ source, resolvedPath: source });
      continue;
    }

    // Everything else is an external package/module — skip.
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