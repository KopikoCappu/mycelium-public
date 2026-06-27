import * as fs from 'fs';
import type {
  GraphNode,
  GraphEdge,
  EdgeKind,
  NodeSummary,
  SubGraph,
  DependencyMap,
  TeamLens,
} from './schema';

interface GraphData {
  nodes: Record<string, GraphNode>;
  edges: Record<string, GraphEdge>;
  lastUpdated: number;
}

export class GraphStore {
  private data: GraphData;
  private filePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.load();
  }

  private load(): GraphData {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as GraphData;
      }
    } catch { /* corrupt file, start fresh */ }
    return { nodes: {}, edges: {}, lastUpdated: Date.now() };
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.data.lastUpdated = Date.now();
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    }, 1500);
  }

  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.data.lastUpdated = Date.now();
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  upsertNode(node: GraphNode): void {
    this.data.nodes[node.id] = node;
    this.scheduleSave();
  }

  updateDescription(nodeId: string, description: string, tags: string[]): void {
    const node = this.data.nodes[nodeId];
    if (!node) return;
    node.description = description;
    node.tags = tags;
    this.scheduleSave();
  }

  deleteNodesForFile(filePath: string): void {
    for (const id of Object.keys(this.data.nodes)) {
      if (this.data.nodes[id].path === filePath) delete this.data.nodes[id];
    }
    this.scheduleSave();
  }

  getNode(id: string): GraphNode | undefined { return this.data.nodes[id]; }

  getFileHash(filePath: string): string | undefined { return this.data.nodes[filePath]?.lastHash; }

  upsertEdge(edge: GraphEdge): void {
    const ex = this.data.edges[edge.id];
    if (ex) { ex.weight += 1; } else { this.data.edges[edge.id] = edge; }
    this.scheduleSave();
  }

  deleteEdgesForFile(filePath: string): void {
    const fileNodeIds = new Set(
      Object.values(this.data.nodes).filter(n => n.path === filePath).map(n => n.id)
    );
    fileNodeIds.add(filePath);
    for (const id of Object.keys(this.data.edges)) {
      const e = this.data.edges[id];
      if (fileNodeIds.has(e.from)) delete this.data.edges[id];
    }
    this.scheduleSave();
  }

  getSubGraph(lens?: TeamLens): SubGraph {
    const allNodes = Object.values(this.data.nodes);
    let filtered: GraphNode[];
    if (!lens || lens.includeAll) {
      filtered = allNodes;
    } else {
      const inc = new Set(lens.includeTags);
      const exc = new Set(lens.excludeTags ?? []);
      const globs = lens.includeGlobs ?? [];
      filtered = allNodes.filter(n => {
        if (globs.some(g => matchGlob(g, n.path))) return true;
        return n.tags.some(t => inc.has(t)) && !n.tags.some(t => exc.has(t));
      });
    }
    const ids = new Set(filtered.map(n => n.id));
    const edges = Object.values(this.data.edges)
      .filter(e => ids.has(e.from) && ids.has(e.to))
      .map(e => ({ from: e.from, to: e.to, kind: e.kind as EdgeKind }));
    return { nodes: filtered.map(toSummary), edges, totalNodes: filtered.length, filteredBy: lens?.name };
  }

  getDependencies(nodeId: string): DependencyMap | undefined {
    const target = this.getNode(nodeId);
    if (!target) return undefined;
    const edges = Object.values(this.data.edges);
    const dependsOn = edges.filter(e => e.from === nodeId).map(e => this.data.nodes[e.to]).filter(Boolean).map(toSummary);
    const usedBy    = edges.filter(e => e.to   === nodeId).map(e => this.data.nodes[e.from]).filter(Boolean).map(toSummary);
    return { target: toSummary(target), dependsOn, usedBy };
  }

  search(query: string, lens?: TeamLens, limit = 20): NodeSummary[] {
    limit = Math.min(Math.max(1, limit), 100); // clamp 1-100
    const raw = query.toLowerCase().split(/\s+/).filter(Boolean);
    // Strip stop words so "add a new compound page" → ["compound", "page"]
    const STOP = new Set(['a','an','the','add','new','create','make','fix','update',
      'get','set','use','for','to','in','of','on','at','with','from','and','or',
      'is','it','be','do','my','we','i','how','what','where','when','why','that']);
    const words = raw.filter(w => w.length > 2 && !STOP.has(w));
    const searchWords = words.length ? words : raw.filter(w => w.length > 1);
    if (!searchWords.length) return [];

    const scopedIds = lens && !lens.includeAll
      ? new Set(this.getSubGraph(lens).nodes.map(n => n.id))
      : null;

    // Score each node: +3 per word hit in name, +2 in tags, +1 in description
    const scored: Array<{ node: GraphNode; score: number }> = [];
    for (const node of Object.values(this.data.nodes)) {
      if (scopedIds && !scopedIds.has(node.id)) continue;
      const nameLow = node.name.toLowerCase();
      const descLow = node.description.toLowerCase();
      const tagsLow = node.tags.join(' ').toLowerCase();
      let score = 0;
      for (const w of searchWords) {
        if (nameLow.includes(w)) score += 3;
        if (tagsLow.includes(w)) score += 2;
        if (descLow.includes(w)) score += 1;
      }
      if (score > 0) scored.push({ node, score });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => toSummary(s.node));
  }

  getEntryPoints(): NodeSummary[] {
    const imported = new Set(Object.values(this.data.edges).filter(e => e.kind === 'imports').map(e => e.to));
    return Object.values(this.data.nodes).filter(n => n.kind === 'file' && !imported.has(n.id)).map(toSummary);
  }

  getPendingSummarization(limit = 50): GraphNode[] {
    return Object.values(this.data.nodes).filter(n => n.kind === 'file' && !n.description).slice(0, limit);
  }

  getStats() {
    const nodes = Object.values(this.data.nodes);
    const edges = Object.values(this.data.edges);
    return {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      fileCount: nodes.filter(n => n.kind === 'file').length,
      unsummarized: nodes.filter(n => n.kind === 'file' && !n.description).length,
      // Breakdown by edge type
      importEdges:  edges.filter(e => e.kind === 'imports').length,
      exportEdges:  edges.filter(e => e.kind === 'exports').length,
    };
  }

  clearGraph(): void {
    this.data = { nodes: {}, edges: {}, lastUpdated: Date.now() };
    this.flush();
  }

  resolveEdges() {
    const updated: Record<string, GraphEdge> = {};
    let resolved = 0;
    let dropped = 0;
    for (const [id, edge] of Object.entries(this.data.edges)) {
      if (edge.kind !== 'imports') { updated[id] = edge; continue; }
      const resolvedTo = this.resolveNodeId(edge.to);
      if (!resolvedTo) { dropped++; continue; }
      if (resolvedTo !== edge.to) {
        const newId = edge.from + '::imports::' + resolvedTo;
        updated[newId] = { ...edge, id: newId, to: resolvedTo };
        resolved++;
      } else {
        updated[id] = edge;
      }
    }
    this.data.edges = updated;
    this.scheduleSave();
    return { resolved, dropped };
  }

  resolveNodeId(targetPath: string): string | null {
    // 1. Exact match — fastest path, handles files that already have the right extension
    if (this.data.nodes[targetPath]) return targetPath;

    // 2. Strip any known extension to get a bare base path, then try all extensions.
    //    This covers: bare paths from aliases, Python/Rust/C paths without extensions,
    //    and TS paths where the wrong extension was guessed.
    const base = targetPath.replace(
      /\.(tsx?|jsx?|mjs|cjs|py|pyi|go|rs|cpp?|cc|cxx|h(?:pp|h)?|java|html?|css|s[ac]ss|less)$/i,
      ''
    );

    const exts = [
      // TS/JS first — most common in the average Mycelium project
      '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
      // Python
      '.py', '.pyi',
      // Systems languages
      '.go',
      '.rs',
      '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.hh', '.hxx',
      // JVM
      '.java',
      // Web assets (HTML/CSS added last since they're less likely to be bare references)
      '.html', '.htm',
      '.css', '.scss', '.sass', '.less',
    ];

    for (const ext of exts) {
      if (this.data.nodes[base + ext]) return base + ext;
    }

    // 3. Index file variants for TS/JS (e.g. import 'utils' → utils/index.ts)
    for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
      if (this.data.nodes[base + '/index' + ext]) return base + '/index' + ext;
    }

    // 4. Python package __init__ (e.g. import 'utils' → utils/__init__.py)
    if (this.data.nodes[base + '/__init__.py']) return base + '/__init__.py';

    // 5. Case-insensitive fallback — catches Windows path mismatches
    const lower = base.toLowerCase();
    const found = Object.keys(this.data.nodes).find(k =>
      k.toLowerCase().replace(/\.[^.]+$/, '') === lower
    );
    return found ?? null;
  }

  // ─── New methods for graph viewer v2, cbm adapter, and embedding engine ───

  getAllNodes(): GraphNode[] {
    return Object.values(this.data.nodes);
  }

  getAllEdges(): GraphEdge[] {
    return Object.values(this.data.edges);
  }

  getImportNeighbors(nodeId: string): string[] {
    return Object.values(this.data.edges)
      .filter(e => (e.from === nodeId || e.to === nodeId) && e.kind === 'imports')
      .map(e => e.from === nodeId ? e.to : e.from);
  }

  getCallNeighbors(nodeId: string): string[] {
    return Object.values(this.data.edges)
      .filter(e => (e.from === nodeId || e.to === nodeId) && e.kind === 'calls')
      .map(e => e.from === nodeId ? e.to : e.from);
  }

  getFileNodes(): GraphNode[] {
    return Object.values(this.data.nodes).filter(n => n.kind === 'file');
  }
}

function toSummary(node: GraphNode): NodeSummary {
  return { id: node.id, kind: node.kind, name: node.name, description: node.description, tags: node.tags, path: node.path };
}

function matchGlob(pattern: string, filePath: string): boolean {
  // Guard against ReDoS: limit pattern length and strip dangerous regex chars
  // before building the glob-to-regex conversion
  if (!pattern || pattern.length > 300) return false;
  // Escape all regex metacharacters except * which we handle intentionally
  const safe = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials
    .replace(/\*\*/g, 'DSTAR')
    .replace(/\*/g, '[^/]*')
    .replace(/DSTAR/g, '.*');
  try {
    const regex = new RegExp('^' + safe + '$');
    return regex.test(filePath);
  } catch {
    return false;
  }
}