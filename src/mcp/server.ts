import * as http from 'http';
import * as fs   from 'fs';
import * as path from 'path';
import type { GraphStore }      from '../graph/store';
import type { ChangeLogger }    from '../history/logger';
import type { GraphMemConfig, TeamLens } from '../graph/schema';
import { getEngine, expandQuery }        from '../graph/embedding-engine';
import { cbmAdapter }                    from '../integrations/cbm-adapter';
import { SessionManager, formatDuration } from '../sessions';

class RateLimiter {
  private counts = new Map<string, { count: number; resetAt: number }>();
  private readonly MAX    = 60;
  private readonly WINDOW = 60_000;
  check(key: string): boolean {
    const now   = Date.now();
    const entry = this.counts.get(key);
    if (!entry || now > entry.resetAt) {
      this.counts.set(key, { count: 1, resetAt: now + this.WINDOW });
      return true;
    }
    if (entry.count >= this.MAX) return false;
    entry.count++;
    return true;
  }
}

export class McpServer {
  private store:          GraphStore;
  private rateLimiter   = new RateLimiter();
  private changeLogger:   ChangeLogger;
  private config:         GraphMemConfig;
  private configPath:     string;
  private server:         http.Server | null = null;
  private sessionManager: SessionManager;
  private sseClients: Set<http.ServerResponse> = new Set();

  // Three-way ignore split
  private defaultIgnore: string[] = [];
  private userIgnore:    string[] = [];
  private userUnignore:  string[] = [];

  constructor(
    store:        GraphStore,
    changeLogger: ChangeLogger,
    config:       GraphMemConfig,
    projectRoot:  string,
  ) {
    this.store          = store;
    this.changeLogger   = changeLogger;
    this.config         = config;
    this.configPath     = path.join(projectRoot, '.mycelium', 'config.json');
    this.defaultIgnore  = [...config.parser.exclude];
    this.sessionManager = new SessionManager(
      projectRoot,
      path.join(projectRoot, '.mycelium'),
    );
    this.loadUserOverrides();
    this.syncEffectiveExclude();
  }

  // ── Persistence helpers ────────────────────────────────────────────────────

  private loadUserOverrides(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const saved       = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this.userIgnore   = saved.userIgnore   ?? [];
        this.userUnignore = saved.userUnignore ?? [];
      }
    } catch {}
  }

  private saveUserOverrides(): void {
    try {
      const existing = fs.existsSync(this.configPath)
        ? JSON.parse(fs.readFileSync(this.configPath, 'utf8'))
        : {};
      fs.writeFileSync(
        this.configPath,
        JSON.stringify({ ...existing, userIgnore: this.userIgnore, userUnignore: this.userUnignore }, null, 2),
      );
    } catch (e) { console.error('[Mycelium] Could not save config:', e); }
    this.syncEffectiveExclude();
  }

  private syncEffectiveExclude(): void {
    this.config.parser.exclude = [
      ...this.defaultIgnore.filter(p => !this.userUnignore.includes(p)),
      ...this.userIgnore,
    ];
  }

  /** Read the full request body as a string. */
  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end',  ()    => resolve(body));
      req.on('error', reject);
    });
  }

  // ── Server lifecycle ───────────────────────────────────────────────────────

  start(): void {
    if (!this.config.mcp.enabled) return;
    this.server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const origin    = (req as any).headers?.origin || '';
      const isAllowed = ['http://localhost', 'http://127.0.0.1', 'null', ''].some(o =>
        origin === o || origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'),
      );
      res.setHeader('Access-Control-Allow-Origin',  isAllowed ? origin || 'null' : 'http://127.0.0.1');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      try { this.route(req, res); }
      catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })); }
    });
    this.server.listen(this.config.mcp.port, '127.0.0.1', () => {
      console.log(`[GraphMem] MCP server running on http://127.0.0.1:${this.config.mcp.port}`);
    });
  }

  stop(): void { this.server?.close(); }

  // ── Router ─────────────────────────────────────────────────────────────────

  private route(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url      = new URL(req.url || '/', `http://127.0.0.1:${this.config.mcp.port}`);
    const pathname = url.pathname;
    const method   = req.method ?? 'GET';

    if (pathname === '/status')                    return this.handleStatus(res);
    if (pathname === '/graph')                     return this.handleGraph(url, res);
    if (pathname === '/dependencies')              return this.handleDependencies(url, res);
    if (pathname === '/search')                    return this.handleSearch(url, res);
    if (pathname === '/entry-points')              return this.handleEntryPoints(url, res);
    if (pathname === '/ui' || pathname === '/ui/') return this.handleUI(res);
    if (pathname === '/teams')                     return this.handleTeams(res);
    if (pathname === '/debug')                     return this.handleDebug(res);
    if (pathname === '/preflight')                 return this.handlePreflight(url, res);
    if (pathname === '/xref') { this.handleXref(url, res); return; }

    // ── History ──────────────────────────────────────────────────────────────
    if (pathname === '/history') return this.handleHistory(res);

    // ── Task / session management ─────────────────────────────────────────────
    if (pathname === '/task') {
      if (method === 'GET')  return this.handleTaskGet(res);
      if (method === 'POST') { this.handleTaskPost(req, res); return; }
    }
    if (pathname === '/task/start') {
      if (method === 'POST') { this.handleTaskPost(req, res); return; }
    }
    if (pathname === '/task/complete') {
      if (method === 'POST') { this.handleTaskComplete(res); return; }
    }
    if (pathname === '/task/abandon') {
      if (method === 'POST') { this.handleTaskAbandon(res); return; }
    }

    // ── Session summarization ──────────────────────────────────────────────────
    if (pathname.startsWith('/session/') && pathname.endsWith('/summarize') && method === 'POST') {
      const sessionId = pathname.slice('/session/'.length, -'/summarize'.length);
      if (sessionId) { this.handleSessionSummarize(sessionId, req, res); return; }
    }

    // ── Node detail ───────────────────────────────────────────────────────────
    if (pathname.startsWith('/node/')) {
      const id = decodeURIComponent(pathname.slice('/node/'.length));
      if (id.includes('..') || path.isAbsolute(id) || id.startsWith('/')) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid node ID' })); return;
      }
      return this.handleNode(id, res);
    }

    // ── Config ────────────────────────────────────────────────────────────────
    if (pathname === '/config') {
      if (method === 'GET')  return this.handleConfigGet(res);
      if (method === 'POST') { this.handleConfigPost(req, res); return; }
    }

    // ── Describe ──────────────────────────────────────────────────────────────────
    if (pathname === '/describe' && method === 'POST') {
      this.handleDescribe(req, res); return;
    }

    // ── SSE live updates ──────────────────────────────────────────────────────────
    if (pathname === '/events' && method === 'GET') {
      this.handleEvents(res); return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({
      error: 'Not found',
      available: [
        '/status', '/graph', '/node/:id', '/dependencies', '/search',
        '/entry-points', '/teams', '/preflight', '/history',
        '/task', '/task/start', '/task/complete', '/task/abandon',
        '/config', '/ui', '/debug', '/xref', '/session/:id/summarize',
      ],
    }));
  }

  // ── Existing handlers (unchanged) ─────────────────────────────────────────

  private handleStatus(res: http.ServerResponse): void {
    const stats = this.store.getStats();
    res.writeHead(200);
    res.end(JSON.stringify({
      status:  'ok',
      version: (require('../../package.json') as { version: string }).version,
      stats,
      teams:   Object.keys(this.config.teams),
      port:    this.config.mcp.port,
    }));
  }

  private handleGraph(url: URL, res: http.ServerResponse): void {
    const teamName = url.searchParams.get('team');
    const lens     = teamName ? this.config.teams[teamName] : undefined;
    res.writeHead(200);
    res.end(JSON.stringify(this.store.getSubGraph(lens)));
  }

  private handleNode(id: string, res: http.ServerResponse): void {
    const node = this.store.getNode(id);
    if (!node) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: `Node not found: ${id}` }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ node, dependencies: this.store.getDependencies(id) }));
  }

  private handleDependencies(url: URL, res: http.ServerResponse): void {
    const file = url.searchParams.get('file');
    if (!file) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing ?file=' })); return; }
    const deps = this.store.getDependencies(file);
    if (!deps)  { res.writeHead(404); res.end(JSON.stringify({ error: `File not in graph: ${file}` })); return; }
    res.writeHead(200);
    res.end(JSON.stringify(deps));
  }

  private handleSearch(url: URL, res: http.ServerResponse): void {
    if (!this.rateLimiter.check('search')) {
      res.writeHead(429); res.end(JSON.stringify({ error: 'Rate limit exceeded.' })); return;
    }
    const query    = (url.searchParams.get('q') || '').slice(0, 500);
    const teamName = url.searchParams.get('team');
    const limit    = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);
    const lens     = teamName ? this.config.teams[teamName] : undefined;
    res.writeHead(200);
    res.end(JSON.stringify({ query, team: teamName, results: this.store.search(query, lens, limit) }));
  }

  private handleEntryPoints(_url: URL, res: http.ServerResponse): void {
    res.writeHead(200);
    res.end(JSON.stringify({ entryPoints: this.store.getEntryPoints() }));
  }

  private handleTeams(res: http.ServerResponse): void {
    const teams = Object.entries(this.config.teams).map(([name, lens]) => ({
      name,
      includeTags: lens.includeTags,
      excludeTags: lens.excludeTags || [],
      includeAll:  lens.includeAll  || false,
    }));
    res.writeHead(200);
    res.end(JSON.stringify({ teams }));
  }

  private handlePreflight(url: URL, res: http.ServerResponse): void {
    if (!this.rateLimiter.check('preflight')) {
      res.writeHead(429); res.end(JSON.stringify({ error: 'Rate limit exceeded.' })); return;
    }
    const task     = (url.searchParams.get('task') || '').slice(0, 500);
    const teamName = url.searchParams.get('team');
    const lens     = teamName ? this.config.teams[teamName] : undefined;
    const engine   = getEngine();
    if (engine?.isReady()) {
      this.handleSemanticPreflight(task, teamName, lens, res, engine);
    } else {
      this.handleKeywordPreflight(task, teamName, lens, res);
    }
  }

  private handleKeywordPreflight(
    task:     string,
    teamName: string | null,
    lens:     TeamLens | undefined,
    res:      http.ServerResponse,
  ): void {
    const relevant = this.store.search(task, lens, 15);
    const depMaps  = relevant.slice(0, 5).map(n => this.store.getDependencies(n.id)).filter(Boolean);
    const allIds   = new Set(relevant.map(n => n.id));
    for (const dep of depMaps) {
      if (dep) {
        dep.dependsOn.forEach((n: any) => allIds.add(n.id));
        dep.usedBy.forEach(  (n: any) => allIds.add(n.id));
      }
    }
    // Register with active session so we track what the agent was told to read
    this.sessionManager.addPreflightFiles(relevant.map(n => n.id));

    res.writeHead(200);
    res.end(JSON.stringify({
      task,
      team:          teamName,
      mode:          'keyword',
      files:         relevant.map(n => ({ nodeId: n.id, score: 0.5, reason: 'keyword', description: n.description, tags: n.tags })),
      relevantNodes: relevant,
      dependencyMaps: depMaps,
      estimatedScope: allIds.size,
      tokensSaved:   Math.max(0, (40 - relevant.length) * 200),
      contextSummary: buildContextSummary(task, relevant, depMaps as any),
    }));
  }

  private async handleSemanticPreflight(
    task:     string,
    teamName: string | null,
    lens:     TeamLens | undefined,
    res:      http.ServerResponse,
    engine:   NonNullable<ReturnType<typeof getEngine>>,
  ): Promise<void> {
    try {
      const queries      = expandQuery(task);
      const semanticHits = await engine.expandedSearch(queries, 15, 0.25);
      const scored       = new Map<string, { score: number; reason: string }>();
      for (const hit of semanticHits) scored.set(hit.nodeId, { score: hit.score, reason: 'semantic' });
      for (const hit of semanticHits.slice(0, 5)) {
        for (const id of [...this.store.getImportNeighbors(hit.nodeId), ...this.store.getCallNeighbors(hit.nodeId)]) {
          if (!scored.has(id)) {
            const s = (engine.findSimilarNodes(id, 1, 0)[0]?.score ?? 0) * 0.65;
            scored.set(id, { score: s, reason: 'dependency' });
          }
        }
      }
      const results = Array.from(scored.entries()).sort((a, b) => b[1].score - a[1].score).slice(0, 10);
      const files   = results.map(([nodeId, { score, reason }]) => {
        const node = this.store.getNode(nodeId);
        return { nodeId, score: Math.round(score * 1000) / 1000, reason, description: node?.description, tags: node?.tags };
      });
      // Register with active session
      this.sessionManager.addPreflightFiles(files.map(f => f.nodeId));

      res.writeHead(200);
      res.end(JSON.stringify({
        task,
        team:          teamName,
        mode:          'semantic',
        files,
        relevantNodes: files.map(f => this.store.getNode(f.nodeId)).filter(Boolean),
        estimatedScope: files.length,
        tokensSaved:   Math.max(0, (40 - files.length) * 200),
        confidence:    files[0]?.score ?? 0,
        contextSummary: buildContextSummary(
          task,
          files.map(f => ({ id: f.nodeId, name: f.nodeId.split('/').pop() ?? f.nodeId, description: f.description ?? '', path: f.nodeId })),
          [],
        ),
      }));
    } catch {
      this.handleKeywordPreflight(task, teamName, lens, res);
    }
  }

  private async handleXref(url: URL, res: http.ServerResponse): Promise<void> {
    const file = (url.searchParams.get('file') || '').slice(0, 500);
    const fn   = (url.searchParams.get('fn')   || '').slice(0, 500);
    if (!file && !fn) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Provide ?file= and/or ?fn=' })); return;
    }
    const importNeighbors = file ? this.store.getImportNeighbors(file) : [];
    const callNeighbors   = file ? this.store.getCallNeighbors(file)   : [];
    let functionTrace     = { callers: [] as any[], callees: [] as any[] };
    if (fn) { try { functionTrace = await cbmAdapter.traceFunction(fn, process.cwd(), 3); } catch {} }
    res.writeHead(200);
    res.end(JSON.stringify({
      file,
      function:         fn,
      importNeighbors:  importNeighbors.map(id => ({ id, node: this.store.getNode(id) })),
      callNeighbors:    callNeighbors.map(  id => ({ id, node: this.store.getNode(id) })),
      functionCallers:  functionTrace.callers,
      functionCallees:  functionTrace.callees,
      impactSummary:    `${callNeighbors.length} files connected via calls, ${importNeighbors.length} via imports`,
    }));
  }

  private handleUI(res: http.ServerResponse): void {
    const candidates = [
      path.join(__dirname, '..', '..', 'ui', 'index.html'),
      path.join(__dirname, '..', 'ui', 'index.html'),
      path.join(process.cwd(), 'ui', 'index.html'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          const html     = fs.readFileSync(candidate, 'utf-8');
          const injected = html.replace("const API_BASE = '';", `const API_BASE = 'http://localhost:${this.config.mcp.port}';`);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(injected);
          return;
        } catch {}
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body style="background:#0e0e12;color:#e0e0f0;font-family:monospace;padding:40px"><h2>🍄 Mycelium</h2><p>Graph viewer not found.</p></body></html>');
  }

  private handleDebug(res: http.ServerResponse): void {
    const stats       = this.store.getStats() as any;
    const graph       = this.store.getSubGraph();
    const importEdges = graph.edges.filter(e => e.kind === 'imports');
    res.writeHead(200);
    res.end(JSON.stringify({
      fileCount:      stats.fileCount,
      totalNodes:     stats.nodeCount,
      totalEdges:     stats.edgeCount,
      importEdges:    stats.importEdges ?? importEdges.length,
      exportEdges:    stats.exportEdges ?? 0,
      sampleNodeIds:  graph.nodes.filter(n => n.kind === 'file').slice(0, 5).map(n => n.id),
      sampleImportEdges: importEdges.slice(0, 8).map(e => ({ from: e.from, to: e.to })),
      diagnosis:      importEdges.length === 0
        ? 'No import edges — alias resolution may not be matching node IDs'
        : 'Import edges present',
    }));
  }

  // ── History — now session-based ───────────────────────────────────────────

  private handleHistory(res: http.ServerResponse): void {
    // Refresh from disk first so CLI-written sessions are always included
    this.sessionManager.refresh();
    res.writeHead(200);
    res.end(JSON.stringify(this.sessionManager.toHistoryResponse()));
  }

  /** POST /describe — persist an inline description edit to disk */
private async handleDescribe(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await this.readBody(req);
    const { nodeId, description, tags } = JSON.parse(body) as {
      nodeId: string;
      description: string;
      tags?: string[];
    };
    if (!nodeId || typeof description !== 'string') {
      res.writeHead(400); res.end(JSON.stringify({ error: 'nodeId and description required' })); return;
    }
    this.store.updateDescription(nodeId, description, tags ?? []);
    res.writeHead(200); res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(400); res.end(JSON.stringify({ error: String(e) }));
  }
}

/** GET /events — SSE stream that pushes graph-updated when the graph changes */
  private handleEvents(res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('data: connected\n\n');
    this.sseClients.add(res);
    res.on('close', () => this.sseClients.delete(res));
  }

  /** Call this whenever the graph is rebuilt — notifies all connected browsers */
  public broadcastGraphUpdate(): void {
    for (const client of this.sseClients) {
      try { client.write('event: graph-updated\ndata: {}\n\n'); }
      catch { this.sseClients.delete(client); }
    }
  }

  // ── Task / session endpoints ──────────────────────────────────────────────

  /** GET /task — active session status */
  private handleTaskGet(res: http.ServerResponse): void {
    this.sessionManager.refresh();
    const active = this.sessionManager.getActiveSession();
    if (!active) {
      res.writeHead(200);
      res.end(JSON.stringify({ active: false, task: null, durationMs: 0 }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({
      active:       true,
      id:           active.id,
      task:         active.task,
      startedAt:    active.startedAt,
      durationMs:   Date.now() - active.startedAt,
      filesInScope: active.preflightFiles.length,
    }));
  }

  /** POST /task  or  POST /task/start — start a new session */
  private async handleTaskPost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body     = await this.readBody(req);
      const { task } = JSON.parse(body) as { task: string };
      if (!task || typeof task !== 'string') {
        res.writeHead(400); res.end(JSON.stringify({ error: '"task" string required' })); return;
      }
      // Pass current graph nodes so snapshot uses cached line counts (fast)
      const graphNodes = this.store.getFileNodes();
      const session    = this.sessionManager.startSession(task, graphNodes);
      res.writeHead(200);
      res.end(JSON.stringify({
        id:           session.id,
        task:         session.task,
        startedAt:    session.startedAt,
        snapshotSize: Object.keys(session.snapshot).length,
      }));
    } catch (e) {
      res.writeHead(400); res.end(JSON.stringify({ error: String(e) }));
    }
  }

  /** POST /task/complete — end session and compute diff */
  private handleTaskComplete(res: http.ServerResponse): void {
    const session = this.sessionManager.completeSession();
    if (!session) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'No active task. Start one with: mycelium task "your task"' }));
      return;
    }
    const r = session.result!;
    res.writeHead(200);
    res.end(JSON.stringify({
      task:              session.task,
      durationMs:        r.durationMs,
      duration:          formatDuration(r.durationMs),
      filesAdded:        r.filesAdded,
      filesChanged:      r.filesChanged,
      filesDeleted:      r.filesDeleted,
      totalLinesAdded:   r.totalLinesAdded,
      totalLinesRemoved: r.totalLinesRemoved,
      changes:           r.changes,
    }));
  }

  /** POST /task/abandon — drop session without recording */
  private handleTaskAbandon(res: http.ServerResponse): void {
    const session = this.sessionManager.abandonSession();
    if (!session) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'No active task' })); return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ message: `Abandoned: "${session.task}"` }));
  }


  // ── AI session summarization ──────────────────────────────────────────────

  /** Make a direct call to Claude Haiku. Returns null if no API key is set. */
  private async callHaiku(prompt: string): Promise<string | null> {
    let apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      try {
        const os = require('os');
        const cfgPath = path.join(os.homedir(), '.mycelium', 'config.json');
        if (fs.existsSync(cfgPath)) {
          apiKey = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).apiKey;
        }
      } catch {}
    }
    if (!apiKey) return null;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':    'application/json',
          'x-api-key':       apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 256,
          messages:   [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as any;
      return data.content?.[0]?.text ?? null;
    } catch {
      return null;
    }
  }

  /**
   * POST /session/:id/summarize
   * Sends session metadata + file descriptions to Haiku and returns a
   * 2-3 sentence plain-English summary of what the session accomplished.
   * Result is cached in sessions.json so repeat calls are instant.
   */
  private async handleSessionSummarize(sessionId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.sessionManager.refresh();

    // Return cached summary unless force: true was sent
    const bodyStr = await this.readBody(req);
    const force   = (() => { try { return JSON.parse(bodyStr).force === true; } catch { return false; } })();
    const cached  = !force && this.sessionManager.getSummary(sessionId);
    if (cached) {
      res.writeHead(200);
      res.end(JSON.stringify({ summary: cached, cached: true }));
      return;
    }

    const sessions = this.sessionManager.getSessions(100);
    const session  = sessions.find(s => s.id === sessionId);

    if (!session) {
      res.writeHead(404); res.end(JSON.stringify({ error: 'Session not found' })); return;
    }
    if (!session.result) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Session is not complete yet' })); return;
    }

    const r = session.result;
    const fileLines: string[] = [];
    let hasDiffs = false;

    for (const f of r.filesAdded) {
      const c    = r.changes[f] as any;
      const node = this.store.getNode(f);
      const desc = node?.description ? ` (${node.description})` : '';
      fileLines.push(`\nADDED: ${f}${desc}`);
      if (c?.diff) {
        hasDiffs = true;
        fileLines.push(c.diff);
      } else {
        fileLines.push(`(${c?.linesAfter ?? '?'} lines — no diff available)`);
      }
    }
    for (const f of r.filesChanged) {
      const c     = r.changes[f] as any;
      const node  = this.store.getNode(f);
      const delta = c ? (c.delta >= 0 ? `+${c.delta}` : `${c.delta}`) : '';
      const desc  = node?.description ? ` (${node.description})` : '';
      fileLines.push(`\nMODIFIED: ${f}${desc} [${c?.linesBefore}→${c?.linesAfter} lines, ${delta}]`);
      if (c?.diff) {
        hasDiffs = true;
        fileLines.push(c.diff);
      } else {
        fileLines.push('(no diff available — re-run task done after committing to git)');
      }
    }
    for (const f of r.filesDeleted) {
      fileLines.push(`\nDELETED: ${f}`);
    }

    // If we have no diffs at all, tell Haiku to be honest about it
    if (!hasDiffs) {
      fileLines.push('\nNote: No git diff was captured for this session. ' +
        'Summarize based on file names and descriptions only, and note that details are limited.');
    }

    const totalFiles = r.filesAdded.length + r.filesChanged.length + r.filesDeleted.length;
    const dur        = formatDuration(r.durationMs);

    const prompt = [
      'Summarize this coding session in 2-3 sentences.',
      'Base your summary ONLY on the actual diff lines shown below — do not infer from file names or descriptions.',
      'If the changes are minor (e.g. only comments or whitespace), say so plainly.',
      'Write in past tense. Do not start with "The developer". Be specific and honest.',
      '',
      `Task: "${session.task}"`,
      `Duration: ${dur}`,
      `Files changed: ${totalFiles}`,
      '',
      '--- Changes ---',
      ...fileLines,
    ].join('\n');

    const summary = await this.callHaiku(prompt);

    if (!summary) {
      res.writeHead(400);
      res.end(JSON.stringify({
        error: 'No Anthropic API key found. Run: mycelium key sk-ant-...',
        noKey: true,
      }));
      return;
    }

    // Cache so repeat clicks are instant
    this.sessionManager.setSummary(sessionId, summary);

    res.writeHead(200);
    res.end(JSON.stringify({ summary, cached: false }));
  }

  // ── Config endpoints ──────────────────────────────────────────────────────

  private handleConfigGet(res: http.ServerResponse): void {
    res.writeHead(200);
    res.end(JSON.stringify({
      defaultIgnore: this.defaultIgnore,
      userIgnore:    this.userIgnore,
      userUnignore:  this.userUnignore,
    }));
  }

  private async handleConfigPost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body              = await this.readBody(req);
      const { action, pattern } = JSON.parse(body) as { action: string; pattern: string };
      switch (action) {
        case 'add':
          if (pattern && !this.userIgnore.includes(pattern)) this.userIgnore.push(pattern);
          break;
        case 'remove':
          if (this.defaultIgnore.includes(pattern)) {
            if (!this.userUnignore.includes(pattern)) this.userUnignore.push(pattern);
          } else {
            this.userIgnore = this.userIgnore.filter(p => p !== pattern);
          }
          break;
        case 'restore':
          this.userUnignore = this.userUnignore.filter(p => p !== pattern);
          break;
        case 'reset':
          this.userIgnore = []; this.userUnignore = [];
          break;
        default:
          res.writeHead(400); res.end(JSON.stringify({ error: `Unknown action: ${action}` })); return;
      }
      this.saveUserOverrides();
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400); res.end(JSON.stringify({ error: String(e) }));
    }
  }
}

function buildContextSummary(
  task:     string,
  relevant: Array<{ id: string; name: string; description: string; path: string }>,
  depMaps:  Array<{ target: any; dependsOn: any[]; usedBy: any[] }>,
): string {
  // Use a helper so we never need escaped backticks inside template literals
  const bt = (s: string) => '`' + s + '`';
  return [
    `## Mycelium Pre-flight: "${task}"`, '',
    '### Relevant files:',
    ...relevant.slice(0, 10).map(n => `- ${bt(n.path)} — ${n.description || '(no description yet)'}`), '',
    '### Key dependencies:',
    ...depMaps.flatMap(dep =>
      dep.dependsOn.length > 0
        ? [`${bt(dep.target.path)} imports from: ${dep.dependsOn.map((d: any) => bt(d.path)).join(', ')}`]
        : [],
    ), '',
    '### What imports these files:',
    ...depMaps.flatMap(dep =>
      dep.usedBy.length > 0
        ? [`${bt(dep.target.path)} is used by: ${dep.usedBy.map((d: any) => bt(d.path)).join(', ')}`]
        : [],
    ),
  ].join('\n');
}