/**
 * Mycelium ↔ codebase-memory-mcp Adapter
 *
 * Bridges the structural graph from codebase-memory-mcp (cbm) into
 * Mycelium's graph store. Mycelium adds the AI understanding layer
 * (Claude Haiku descriptions, natural language preflight, history tracking)
 * on top of cbm's structural backbone (158 languages, call graph, sub-ms queries).
 *
 * cbm CLI is invoked via shell — no native bindings needed.
 */

import { spawnSync } from 'child_process';
import type { GraphNode, GraphEdge } from '../graph/schema';
import crypto from 'crypto';
import path from 'path';

// ─── Types matching cbm JSON output ──────────────────────────────────────────

interface CbmNode {
  id?: string;
  name: string;
  label: string;
  file?: string;          // legacy compat
  file_path?: string;     // actual field cbm returns
  line?: number;
  line_end?: number;
  qualified_name?: string;
  exported?: boolean;
}

interface CbmEdge {
  from: string;
  to: string;
  type: string;           // 'CALLS' | 'IMPORTS' | 'DEFINES' | 'CONTAINS' | ...
  weight?: number;
}

export interface CbmGraph {
  nodes: CbmNode[];
  edges: CbmEdge[];
}

export interface CbmAdapterResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    nodesImported: number;
    edgesImported: number;
    callEdges: number;
    importEdges: number;
    languages: string[];
  };
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class CbmAdapter {
  private cbmBin: string;

  constructor() {
    this.cbmBin = this.findBinary();
  }

  private findBinary(): string {
    const candidates = ['codebase-memory-mcp', 'cbm'];
    for (const bin of candidates) {
      try {
        spawnSync(bin, ['--version'], { timeout: 3000, stdio: 'pipe' });
        return bin;
      } catch { /* try next */ }
    }
    return 'codebase-memory-mcp';
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = spawnSync(this.cbmBin, ['--version'], {
        timeout: 5000,
        stdio: 'pipe',
      });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  /** Run cbm index on a project. Returns the slug cbm uses as the project key. */
  async index(repoPath: string): Promise<string> {
    const result = spawnSync(
      this.cbmBin,
      ['cli', 'index_repository', JSON.stringify({ repo_path: path.resolve(repoPath) })],
      { timeout: 300_000, stdio: 'pipe', encoding: 'utf-8' }
    );

    if (result.status !== 0) {
      throw new Error(`cbm index failed: ${result.stderr?.slice(0, 500)}`);
    }

    // cbm may prefix output with log lines like "level=info msg=..."
    // Find the first line that is valid JSON
    const jsonLine = result.stdout.trim().split('\n').find(l => l.trim().startsWith('{'));
    if (!jsonLine) throw new Error('cbm index returned no JSON output');
    const parsed = JSON.parse(jsonLine);
    return parsed.project; // e.g. "C-Users-Minh-Tran-Desktop-pakky"
  }

  /** Pull the full graph from cbm and convert to Mycelium format. */
  async getGraph(repoPath: string, exclude: string[] = []): Promise<CbmAdapterResult> {
    const absPath = path.resolve(repoPath);
    const project = await this.index(absPath); // get slug from cbm directly

    const fnResult = this.runCbmCli('search_graph', {
      label: 'Function',
      project,
      limit: 10000,
    });

    const fileResult = this.runCbmCli('search_graph', {
      label: 'File',
      project,
      limit: 10000,
    });

    const archResult = this.runCbmCli('get_architecture', {
      repo_path: absPath,
    });

    const fnNodes: CbmNode[] = fnResult?.results ?? [];
    const fileNodes: CbmNode[] = fileResult?.results ?? [];
    const allCbmNodes = [...fileNodes, ...fnNodes];

    const myceliumNodes = this.convertNodes(allCbmNodes, absPath, exclude);
    const callEdges = await this.buildCallEdges(fnNodes, absPath, project);
    const languages: string[] = archResult?.languages ?? [];

    const importEdges = callEdges.filter(e => e.kind === 'imports');
    const calls = callEdges.filter(e => e.kind === 'calls');

    return {
      nodes: myceliumNodes,
      edges: callEdges,
      stats: {
        nodesImported: myceliumNodes.length,
        edgesImported: callEdges.length,
        callEdges: calls.length,
        importEdges: importEdges.length,
        languages,
      },
    };
  }

  /** Trace callers and callees for a specific function. Used by /xref. */
  async traceFunction(
    fnName: string,
    repoPath: string,
    depth = 3
  ): Promise<{
    callers: Array<{ name: string; file: string; line?: number }>;
    callees: Array<{ name: string; file: string; line?: number }>;
  }> {
    const absPath = path.resolve(repoPath);
    const project = await this.index(absPath);

    const result = this.runCbmCli('trace_path', {
      function_name: fnName,
      project,
      direction: 'both',
      depth,
    });

    if (!result) return { callers: [], callees: [] };

    const callers = (result.callers ?? result.inbound ?? []).map((n: any) => ({
      name: n.name,
      file: this.resolveNodeFilePath(n, absPath, project, n.name),
      line: n.line,
    }));

    const callees = (result.callees ?? result.outbound ?? []).map((n: any) => ({
      name: n.name,
      file: this.resolveNodeFilePath(n, absPath, project, n.name),
      line: n.line,
    }));

    return { callers, callees };
  }

  /** Get changed symbols from git diff. Used to enrich history log. */
  async detectChanges(repoPath: string): Promise<Array<{
    file: string;
    symbol: string;
    riskLevel: 'HIGH' | 'MEDIUM' | 'LOW';
    callersAffected: number;
  }>> {
    const absPath = path.resolve(repoPath);

    const result = this.runCbmCli('detect_changes', {
      repo_path: absPath,
    });

    if (!result?.changes) return [];

    return result.changes.map((c: any) => ({
      file: c.file ?? '',
      symbol: c.symbol ?? c.name ?? '',
      riskLevel: c.risk_level ?? 'MEDIUM',
      callersAffected: c.callers_affected ?? 0,
    }));
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private runCbmCli(tool: string, args: Record<string, unknown>): any {
    try {
      const result = spawnSync(
        this.cbmBin,
        ['cli', tool, JSON.stringify(args)],
        { timeout: 30_000, stdio: 'pipe', encoding: 'utf-8' }
      );

      if (result.status !== 0 || !result.stdout) return null;
      // cbm may prefix output with log lines — find the JSON line
      const jsonLine = result.stdout.trim().split('\n').find(l => l.trim().startsWith('{'));
      if (!jsonLine) return null;
      return JSON.parse(jsonLine);
    } catch {
      return null;
    }
  }

  /**
   * Resolve a CBM node's file reference to a Mycelium-style relative path.
   *
   * Priority order:
   *   1. file_path field — may be absolute, needs path.relative()
   *   2. file field (legacy) — same treatment
   *   3. qualified_name — derive via qualifiedNameToFilePath()
   *   4. name — last resort
   *
   * This is the single source of truth for "what file does this CBM node live in?"
   * Used by convertNodes(), buildCallEdges(), and traceFunction().
   */
  private resolveNodeFilePath(
    node: CbmNode | Record<string, any>,
    repoPath: string,   // absolute path to repo root
    project: string,
    funcName: string
  ): string {
    const absRepoPath = path.resolve(repoPath);

    // 1. file_path (most reliable — cbm 0.6+ always populates this)
    if (node.file_path) {
      return this.toRelative(node.file_path, absRepoPath);
    }

    // 2. Legacy file field
    if (node.file) {
      return this.toRelative(node.file, absRepoPath);
    }

    // 3. Derive from qualified_name
    if (node.qualified_name) {
      return this.qualifiedNameToFilePath(node.qualified_name, project, funcName);
    }

    // 4. Last resort
    return node.name ?? '';
  }

  /**
   * Convert any path (absolute or already relative) to a Mycelium node ID.
   * Mycelium stores all nodes as paths relative to the workspace root,
   * using forward slashes.
   *
   * Bug this fixes: CBM returns absolute paths like
   *   "C:/Users/Minh Tran/Desktop/pakky/src/components/File.tsx"
   * but Mycelium nodes are keyed by
   *   "src/components/File.tsx"
   * so every edge had from/to = absolute path → matched nothing in the store.
   */
  private toRelative(filePath: string, absRepoPath: string): string {
    if (!filePath) return '';

    // Already relative (doesn't start with drive letter or /)
    if (!path.isAbsolute(filePath)) return filePath.replace(/\\/g, '/');

    // Make relative to repo root
    return path.relative(absRepoPath, filePath).replace(/\\/g, '/');
  }

  /**
   * Derive a relative file path from a cbm qualified_name.
   * Format: "{project-slug}.{path.with.dots}.{functionName}"
   * e.g. "C-Users-Minh-Tran-Desktop-pakky.src.components.BroadcastButton.deletePreset"
   * → "src/components/BroadcastButton"
   *
   * Note: the result has no extension — resolveNodeId() in store.ts will add it.
   */
  private qualifiedNameToFilePath(qualifiedName: string, project: string, funcName: string): string {
    const withoutProject = qualifiedName.startsWith(project + '.')
      ? qualifiedName.slice(project.length + 1)
      : qualifiedName;

    const withoutFunc = withoutProject.endsWith('.' + funcName)
      ? withoutProject.slice(0, -(funcName.length + 1))
      : withoutProject;

    // Replace dots with slashes — works for standard TS/JS paths
    return withoutFunc.replace(/\./g, '/');
  }

  private matchesExclude(filePath: string, exclude: string[]): boolean {
    return exclude.some(pat => {
      const clean = pat
        .replace(/^\*\*\//, '')
        .replace(/\/\*\*$/, '')
        .replace(/\/\*$/, '')
        .replace(/\/$/, '');

      if (!clean || clean.includes('*')) return false;

      return (
        filePath === clean ||
        filePath.startsWith(clean + '/') ||
        filePath.includes('/' + clean + '/')
      );
    });
  }

  private convertNodes(cbmNodes: CbmNode[], repoPath: string, exclude: string[]): GraphNode[] {
    const now = Date.now();
    const nodes: GraphNode[] = [];

    for (const n of cbmNodes) {
      const label = n.label?.toLowerCase() ?? 'file';
      const kind  = this.mapLabel(label);

      // ── FIX: always resolve to a relative path ──────────────────────────
      // Previously: n.file_path was used raw (often absolute) which meant
      // node IDs didn't match anything in the Mycelium store.
      const filePath = this.resolveNodeFilePath(n, repoPath, '', n.name);

      if (!filePath) continue;

      // Skip files matching the ignore list
      if (this.matchesExclude(filePath, exclude)) continue;

      const id = kind === 'file'
        ? filePath
        : `${filePath}::${n.qualified_name ?? n.name}`;

      nodes.push({
        id,
        kind,
        path: filePath,
        name: n.name,
        description: '',
        tags: [],
        exported: n.exported ?? false,
        lineStart: n.line,
        lineEnd: n.line_end,
        lastHash: crypto.createHash('sha256').update(id).digest('hex').slice(0, 16),
        lastUpdated: now,
      });
    }

    return nodes;
  }

  private mapLabel(label: string): GraphNode['kind'] {
    if (label === 'file' || label === 'module') return 'file';
    if (label === 'function' || label === 'method') return 'function';
    if (label === 'class' || label === 'struct') return 'class';
    if (label === 'interface' || label === 'trait') return 'interface';
    if (label === 'type' || label === 'enum') return 'type';
    return 'file';
  }

  private async buildCallEdges(
    fnNodes: CbmNode[],
    repoPath: string,
    project: string
  ): Promise<GraphEdge[]> {
    const edges: GraphEdge[] = [];
    const seen   = new Set<string>();
    const sample = fnNodes.slice(0, 200);

    for (const fn of sample) {
      const result = this.runCbmCli('trace_path', {
        function_name: fn.qualified_name ?? fn.name,
        project,
        direction: 'outbound',
        depth: 1,
      });

      if (!result?.callees) continue;

      // ── FIX: make fromFile relative ───────────────────────────────────────
      // Previously: fn.file_path was used raw (often an absolute OS path)
      // so the edge from-ID never matched any node in the store.
      const fromFile = this.resolveNodeFilePath(fn, repoPath, project, fn.name);
      if (!fromFile) continue;

      for (const callee of result.callees) {
        // ── FIX: resolve callee file path the same way ─────────────────────
        const toFile = this.resolveNodeFilePath(callee, repoPath, project, callee.name);
        if (!toFile) continue;

        // Skip self-references and obvious noise
        if (fromFile === toFile) continue;

        const edgeId = `${fromFile}::calls::${toFile}`;
        if (seen.has(edgeId)) continue;
        seen.add(edgeId);

        edges.push({ id: edgeId, from: fromFile, to: toFile, kind: 'calls', weight: 1 });
      }
    }

    return edges;
  }
}

/** Singleton — one adapter per process */
export const cbmAdapter = new CbmAdapter();