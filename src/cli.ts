import { Command } from 'commander';
import * as path from 'path';
import * as fs   from 'fs';
import * as os   from 'os';
import { glob }  from 'glob';

import { GraphStore }           from './graph/store';
import { Summarizer }           from './graph/summarizer';
import { McpServer }            from './mcp/server';
import { parser }               from './parser/treeSitter';
import { detectSourceGlobs }    from './parser/detect';
import { ChangeLogger }         from './history/logger';
import { bootstrapAgentFiles }  from './bootstrap';
import { DEFAULT_CONFIG, type GraphMemConfig } from './graph/schema';
import { EmbeddingEngine, initEngine }         from './graph/embedding-engine';
import { cbmAdapter }           from './integrations/cbm-adapter';
import { SessionManager, formatDuration } from './sessions';

// ─── Global config path ───────────────────────────────────────────────────────
const { version: VERSION } = require('../package.json') as { version: string };

const GLOBAL_CONFIG_DIR  = path.join(os.homedir(), '.mycelium');
const GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, 'config.json');

function getGlobalConfig(): { apiKey?: string; openAiKey?: string } {
  try { if (fs.existsSync(GLOBAL_CONFIG_FILE)) return JSON.parse(fs.readFileSync(GLOBAL_CONFIG_FILE, 'utf8')); }
  catch { /* ignore */ }
  return {};
}
function saveGlobalConfig(data: Record<string, string>): void {
  fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
  const existing = getGlobalConfig();
  fs.writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify({ ...existing, ...data }, null, 2));
  try { fs.chmodSync(GLOBAL_CONFIG_FILE, 0o600); } catch { /* Windows - no-op */ }
}
function getApiKey():    string | null      { return process.env.ANTHROPIC_API_KEY ?? getGlobalConfig().apiKey ?? null; }
function getOpenAiKey(): string | undefined { return process.env.OPENAI_API_KEY    ?? getGlobalConfig().openAiKey ?? undefined; }

// ─── Project helpers ──────────────────────────────────────────────────────────

function resolveRoot(input?: string): string { return path.resolve(input ?? process.cwd()); }

function loadProjectConfig(root: string): GraphMemConfig {
  const cfgPath = path.join(root, '.mycelium', 'config.json');
  if (fs.existsSync(cfgPath)) {
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) }; } catch { /* fall through */ }
  }
  return DEFAULT_CONFIG;
}

function initProjectDir(root: string): { store: GraphStore; logger: ChangeLogger; config: GraphMemConfig } {
  const dir = path.join(root, '.mycelium');
  fs.mkdirSync(dir, { recursive: true });
  const config = loadProjectConfig(root);
  const store  = new GraphStore(path.join(dir, 'graph.json'));
  const logger = new ChangeLogger(path.join(dir, 'history.json'));
  return { store, logger, config };
}

// ─── Terminal helpers ─────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
  bold:   '\x1b[1m',
  purple: '\x1b[35m',
  red:    '\x1b[31m',
};

function log(msg: string)  { console.log(msg); }
function ok(msg: string)   { console.log(`  ${C.green}✓${C.reset} ${msg}`); }
function info(msg: string) { console.log(`  ${C.cyan}◆${C.reset} ${msg}`); }
function warn(msg: string) { console.log(`  ${C.yellow}!${C.reset} ${msg}`); }
function dim(msg: string)  { console.log(`  ${C.gray}${msg}${C.reset}`); }
function err(msg: string)  { console.log(`  ${C.red}✗${C.reset} ${msg}`); }

function header() {
  console.log(`\n  ${C.purple}${C.bold}🍄 Mycelium${C.reset}${C.gray} v${VERSION}${C.reset}\n`);
}

// ─── Core scan logic ──────────────────────────────────────────────────────────

async function runScan(root: string, store: GraphStore, config: GraphMemConfig, force = false): Promise<number> {
  const hasCbm = await cbmAdapter.isAvailable();
  if (hasCbm) {
    info(`${C.green}codebase-memory-mcp detected${C.reset} — using for structural indexing`);
    try {
      const cbmResult = await cbmAdapter.getGraph(root, config.parser.exclude);
      for (const node of cbmResult.nodes) { if (!store.getNode(node.id)) store.upsertNode(node); }
      for (const edge of cbmResult.edges) store.upsertEdge(edge);
      ok(`Indexed ${cbmResult.stats.nodesImported} nodes, ${cbmResult.stats.edgesImported} edges via cbm`);
      if (cbmResult.stats.languages.length > 0) dim(`Languages: ${cbmResult.stats.languages.slice(0, 8).join(', ')}`);
    } catch (e: any) {
      warn(`cbm indexing failed, falling back to built-in parser: ${e.message?.slice(0, 100)}`);
    }
  }

  const sourceGlobs = detectSourceGlobs(root);
  info(`Detected: ${C.gray}${sourceGlobs.join(', ')}${C.reset}`);

  const files = await glob(sourceGlobs, { cwd: root, ignore: config.parser.exclude, absolute: true });
  let changed = 0;

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    const rel     = path.relative(root, filePath).replace(/\\/g, '/');
    const result  = parser.parseFile(filePath, content, root);
    if (!force && store.getFileHash(rel) === result.fileNode.lastHash) continue;
    changed++;
    store.deleteNodesForFile(rel);
    store.deleteEdgesForFile(rel);
    store.upsertNode(result.fileNode);
    for (const sym  of result.symbolNodes) store.upsertNode(sym);
    for (const edge of result.edges)       store.upsertEdge(edge);
  }

  const { resolved, dropped } = store.resolveEdges();
  const stats = store.getStats();
  ok(`Parsed ${stats.fileCount} files${changed > 0 ? ` (${changed} updated)` : ' (no changes)'}`);
  ok(`${stats.importEdges ?? 0} import edges${C.gray} · ${dropped} external dropped · ${stats.exportEdges ?? 0} export edges${C.reset}`);
  if ((stats.importEdges ?? 0) === 0 && stats.fileCount > 0) {
    warn('No import edges found — imports may use unresolved aliases. Run: mycelium debug');
  }
  return changed;
}

async function runSummarize(root: string, store: GraphStore, config: GraphMemConfig): Promise<void> {
  const apiKey = getApiKey();
  if (!apiKey) {
    warn(`No API key — skipping summarization. Run: ${C.cyan}mycelium key <your-key>${C.reset}`);
    return;
  }
  const pending = store.getPendingSummarization(500);
  if (pending.length === 0) { ok('All files already summarized'); return; }
  info(`Summarizing ${pending.length} files with Claude Haiku...`);
  const summarizer = new Summarizer({ ...config.summarizer, apiKey });
  await summarizer.summarizePending(store, (filePath) => {
    const abs = path.join(root, filePath);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  });
  ok('Summarization complete');
}

// ─── File watcher ─────────────────────────────────────────────────────────────
// NOTE: The watcher updates the graph when files change but does NOT log
// individual saves to history anymore. History is now session-based:
// use `mycelium task "description"` + `mycelium task done`.

async function startWatcher(root: string, store: GraphStore, config: GraphMemConfig, onUpdate?: () => void): Promise<void> {
  const chokidar    = await import('chokidar');
  const sourceGlobs = detectSourceGlobs(root);

  const watcher = chokidar.watch(sourceGlobs, {
    cwd:            root,
    ignoreInitial:  true,
    ignored:        config.parser.exclude,
    persistent:     true,
  });

  const handleChange = async (rel: string) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    const content = fs.readFileSync(abs, 'utf8');
    const result  = parser.parseFile(abs, content, root);
    if (store.getFileHash(rel) === result.fileNode.lastHash) return;

    // Preserve existing summary before deleting the node —
    // otherwise every save looks like an unsummarized file to Claude
    const existing        = store.getNode(rel);
    const savedDescription = existing?.description ?? '';
    const savedTags        = existing?.tags        ?? [];

    store.deleteNodesForFile(rel);
    store.deleteEdgesForFile(rel);

    if (savedDescription) {
      result.fileNode.description = savedDescription;
      result.fileNode.tags        = savedTags;
    }

    store.upsertNode(result.fileNode);
    for (const sym  of result.symbolNodes) store.upsertNode(sym);
    for (const edge of result.edges)       store.upsertEdge(edge);
    store.resolveEdges();

    // Only call Claude for genuinely new/unsummarized files
    const apiKey = getApiKey();
    if (apiKey && !savedDescription) {
      const summarizer = new Summarizer({ ...config.summarizer, apiKey });
      await summarizer.summarizePending(store, () => content);
    }

    dim(`Updated: ${rel}`);
    onUpdate?.();
  };

  watcher.on('change', rel => handleChange(rel));
  watcher.on('add',    rel => handleChange(rel));
  watcher.on('unlink', rel => {
    store.deleteNodesForFile(rel);
    store.deleteEdgesForFile(rel);
    dim(`Removed: ${rel}`);
    onUpdate?.();   // ← add this
  });
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const program = new Command();
program.name('mycelium').description('Codebase memory graph for AI coding agents').version(VERSION);

// ── mycelium init [path] ──────────────────────────────────────────────────────

program
  .command('init [path]')
  .description('Scan codebase, build graph, start server')
  .option('-p, --port <port>', 'MCP server port', '47821')
  .option('--no-serve', 'Skip starting the server')
  .option('--no-watch', 'Skip file watcher')
  .option('--force', 'Force full re-scan even if graph exists')
  .action(async (targetPath: string | undefined, opts: { port: string; serve: boolean; watch: boolean; force: boolean }) => {
    header();
    const root = resolveRoot(targetPath);
    log(`  ${C.gray}${root}${C.reset}\n`);

    let { store, logger, config } = initProjectDir(root);
    config.mcp.port = parseInt(opts.port, 10);

    if (opts.force) { store.clearGraph(); info('Forced full re-scan'); }

    await runScan(root, store, config);
    await runSummarize(root, store, config);

    const openAiKey = getOpenAiKey();
    if (openAiKey) {
      const dir    = path.join(root, '.mycelium');
      const engine = initEngine(dir, openAiKey);
      const toEmbed = store.getFileNodes()
        .filter(n => n.description)
        .map(n => ({ id: n.id, text: EmbeddingEngine.buildText(n) }));
      if (toEmbed.length > 0) {
        info(`Generating semantic embeddings for ${toEmbed.length} files...`);
        const newCount = await engine.embedNodes(toEmbed, (done, total) => {
          process.stdout.write(`\r  ${C.cyan}◆${C.reset} Embedding: ${done}/${total}`);
        });
        process.stdout.write('\n');
        ok(`${newCount} new embeddings (${toEmbed.length - newCount} cached)`);
      }
    }

    bootstrapAgentFiles(root, store, config);
    ok('CLAUDE.md written'); ok('.mcp.json written');

    if (opts.serve) {
      const server = new McpServer(store, logger, config, root);
      server.start();
      log('');
      log(`  ${C.bold}Graph view${C.reset}  ${C.cyan}http://localhost:${config.mcp.port}/ui${C.reset}`);
      log(`  ${C.bold}MCP server${C.reset}  ${C.gray}http://localhost:${config.mcp.port}${C.reset}`);
      log('');
      if (opts.watch) {
        startWatcher(root, store, config, () => server.broadcastGraphUpdate());
        log(`  ${C.gray}Watching for changes... (Ctrl+C to stop)${C.reset}\n`);
        process.on('SIGINT', () => { store.flush(); server.stop(); process.exit(0); });
        await new Promise(() => {});
      }
    }
  });

// ── mycelium serve [path] ─────────────────────────────────────────────────────

program
  .command('serve [path]')
  .description('Start MCP server and file watcher (graph must already exist)')
  .option('-p, --port <port>', 'MCP server port', '47821')
  .option('--no-watch', 'Skip file watcher')
  .action(async (targetPath: string | undefined, opts: { port: string; watch: boolean }) => {
    header();
    const root = resolveRoot(targetPath);
    const { store, logger, config } = initProjectDir(root);
    config.mcp.port = parseInt(opts.port, 10);

    const stats = store.getStats();
    if (stats.fileCount === 0) {
      warn(`No graph found. Run ${C.cyan}mycelium init${C.reset} first.`); process.exit(1);
    }
    ok(`Loaded graph: ${stats.fileCount} files, ${stats.edgeCount} edges`);

    const server = new McpServer(store, logger, config, root);
    server.start();
    log('');
    log(`  ${C.bold}Graph view${C.reset}  ${C.cyan}http://localhost:${config.mcp.port}/ui${C.reset}`);
    log(`  ${C.bold}MCP server${C.reset}  ${C.gray}http://localhost:${config.mcp.port}${C.reset}`);
    log('');

    if (opts.watch) {
      await startWatcher(root, store, config, () => server.broadcastGraphUpdate());
      log(`  ${C.gray}Watching for changes... (Ctrl+C to stop)${C.reset}\n`);
      process.on('SIGINT', () => { store.flush(); server.stop(); process.exit(0); });
      await new Promise(() => {});
    }
  });

// ── mycelium scan [path] ──────────────────────────────────────────────────────

program
  .command('scan [path]')
  .description('Re-scan codebase and update graph (no server)')
  .option('--clear', 'Clear existing graph before scanning')
  .action(async (targetPath: string | undefined, opts: { clear: boolean }) => {
    header();
    const root = resolveRoot(targetPath);
    const { store, config } = initProjectDir(root);
    if (opts.clear) { store.clearGraph(); info('Cleared existing graph'); }
    await runScan(root, store, config, opts.clear);
    await runSummarize(root, store, config);
    bootstrapAgentFiles(root, store, config);
    ok('CLAUDE.md + .mcp.json updated');
    store.flush();
  });

// ── mycelium task [description] ───────────────────────────────────────────────
//
//   mycelium task "add stripe checkout"  →  start session (snapshots files)
//   mycelium task done                   →  complete session (compute diff + print summary)
//   mycelium task abandon                →  drop session silently
//   mycelium task status                 →  show active task info
//
// Works both when the server IS running (talks to it via HTTP so the server's
// in-memory state stays in sync) and when it ISN'T (writes directly to
// .mycelium/sessions.json and the server picks it up on next restart).

program
  .command('task [description]')
  .description('Manage work sessions  (done | abandon | status | "your task")')
  .option('-p, --path <path>', 'Project path', '.')
  .action(async (description: string | undefined, opts: { path: string }) => {
    const root       = resolveRoot(opts.path);
    const { config } = initProjectDir(root);
    const port       = config.mcp.port;
    const base       = `http://127.0.0.1:${port}`;
    const storageDir = path.join(root, '.mycelium');

    // Check if the server is reachable (non-blocking, 300ms timeout)
    async function serverUp(): Promise<boolean> {
      try {
        const ctrl = new AbortController();
        const t    = setTimeout(() => ctrl.abort(), 300);
        await fetch(`${base}/status`, { signal: ctrl.signal });
        clearTimeout(t);
        return true;
      } catch { return false; }
    }

    // ── done / complete ─────────────────────────────────────────────────────
    if (description === 'done' || description === 'complete' || description === 'finish') {
      let data: any;
      if (await serverUp()) {
        const res = await fetch(`${base}/task/complete`, { method: 'POST' });
        if (!res.ok) {
          const e = await res.json().catch(() => ({ error: res.statusText })) as any;
          err(e.error || 'Failed to complete task'); process.exit(1);
        }
        data = await res.json();
      } else {
        // Direct: server not running, use SessionManager on disk
        const { store } = initProjectDir(root);
        const sm      = new SessionManager(root, storageDir);
        const session = sm.completeSession();
        if (!session) { err('No active task.'); process.exit(1); }
        const r = session.result!;
        data = { task: session.task, duration: formatDuration(r.durationMs), durationMs: r.durationMs, filesAdded: r.filesAdded, filesChanged: r.filesChanged, filesDeleted: r.filesDeleted, totalLinesAdded: r.totalLinesAdded, totalLinesRemoved: r.totalLinesRemoved, changes: r.changes };
      }

      const totalFiles = (data.filesAdded?.length ?? 0) + (data.filesChanged?.length ?? 0) + (data.filesDeleted?.length ?? 0);
      log('');
      log(`  ${C.green}${C.bold}✓ Task complete${C.reset}  ${C.gray}${data.duration || formatDuration(data.durationMs)}${C.reset}`);
      log(`  ${C.gray}"${data.task}"${C.reset}`);
      log('');

      if (totalFiles === 0) {
        dim('No file changes detected.');
      } else {
        const addedStr   = data.totalLinesAdded   ? `${C.green}+${data.totalLinesAdded}${C.reset} `   : '';
        const removedStr = data.totalLinesRemoved  ? `${C.red}-${data.totalLinesRemoved}${C.reset}` : '';
        log(`  ${C.bold}${totalFiles}${C.reset} file${totalFiles !== 1 ? 's' : ''} touched  ${addedStr}${removedStr}`);
        log('');

        if (data.filesAdded?.length) {
          log(`  ${C.green}New files:${C.reset}`);
          for (const f of data.filesAdded) {
            const c = data.changes?.[f];
            log(`    ${C.green}+${C.reset} ${f}${c ? C.gray + ` (${c.linesAfter} lines)` + C.reset : ''}`);
          }
        }
        if (data.filesChanged?.length) {
          log(`  ${C.yellow}Modified:${C.reset}`);
          for (const f of data.filesChanged) {
            const c     = data.changes?.[f];
            const delta = c ? (c.delta >= 0 ? `${C.green}+${c.delta}${C.reset}` : `${C.red}${c.delta}${C.reset}`) : '';
            const range = c ? `${C.gray}${c.linesBefore}→${c.linesAfter} lines${C.reset}  ` : '';
            log(`    ${C.yellow}~${C.reset} ${f}  ${range}${delta}`);
          }
        }
        if (data.filesDeleted?.length) {
          log(`  ${C.red}Deleted:${C.reset}`);
          for (const f of data.filesDeleted) log(`    ${C.red}-${C.reset} ${f}`);
        }
      }
      log('');
      dim('Recorded in session history. Open the graph viewer to review.');
      log('');
      return;
    }

    // ── abandon / cancel ────────────────────────────────────────────────────
    if (description === 'abandon' || description === 'cancel' || description === 'drop') {
      if (await serverUp()) {
        const res = await fetch(`${base}/task/abandon`, { method: 'POST' });
        const d   = await res.json().catch(() => ({})) as any;
        ok(d.message || 'Task abandoned');
      } else {
        const sm = new SessionManager(root, storageDir);
        const s  = sm.abandonSession();
        if (!s) { err('No active task.'); } else { ok(`Abandoned: "${s.task}"`); }
      }
      return;
    }

    // ── status / info ───────────────────────────────────────────────────────
    if (description === 'status' || description === 'info' || description === 'current') {
      let data: any;
      if (await serverUp()) {
        const res = await fetch(`${base}/task`);
        data = await res.json();
      } else {
        const sm = new SessionManager(root, storageDir);
        const active = sm.getActiveSession();
        data = active
          ? { active: true, task: active.task, durationMs: Date.now() - active.startedAt, filesInScope: active.preflightFiles.length }
          : { active: false };
      }
      log('');
      if (!data.active) {
        dim('No active task.');
        dim(`Start one with: mycelium task "your task description"`);
      } else {
        log(`  ${C.bold}Active task:${C.reset} "${data.task}"`);
        log(`  ${C.gray}Running for ${formatDuration(data.durationMs)}${C.reset}`);
        if (data.filesInScope) log(`  ${C.gray}${data.filesInScope} files in preflight scope${C.reset}`);
        log('');
        dim('When done: mycelium task done');
      }
      log('');
      return;
    }

    // ── no description — show usage ─────────────────────────────────────────
    if (!description) {
      log('');
      log(`  ${C.bold}mycelium task${C.reset}  ${C.gray}— session management${C.reset}`);
      log('');
      log(`  ${C.cyan}mycelium task "add stripe checkout"${C.reset}  ${C.gray}Start a new task session${C.reset}`);
      log(`  ${C.cyan}mycelium task done${C.reset}                    ${C.gray}Complete + record what changed${C.reset}`);
      log(`  ${C.cyan}mycelium task status${C.reset}                  ${C.gray}Show active task${C.reset}`);
      log(`  ${C.cyan}mycelium task abandon${C.reset}                 ${C.gray}Drop without recording${C.reset}`);
      log('');
      return;
    }

    // ── start a new session ─────────────────────────────────────────────────
    if (await serverUp()) {
      const res = await fetch(`${base}/task/start`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ task: description }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({ error: res.statusText })) as any;
        err(e.error || 'Failed to start task'); process.exit(1);
      }
      const data = await res.json() as any;
      log('');
      log(`  ${C.green}${C.bold}✓ Task started${C.reset}  ${C.gray}snapshot: ${data.snapshotSize} files${C.reset}`);
      log(`  ${C.gray}"${description}"${C.reset}`);
      log('');
      dim('Run your agent. When done: mycelium task done');
      log('');
    } else {
      // Server not running — write directly to disk
      const { store } = initProjectDir(root);
      const sm      = new SessionManager(root, storageDir);
      const session = sm.startSession(description, store.getFileNodes());
      log('');
      log(`  ${C.green}${C.bold}✓ Task started${C.reset}  ${C.gray}snapshot: ${Object.keys(session.snapshot).length} files${C.reset}`);
      log(`  ${C.gray}"${description}"${C.reset}`);
      log('');
      dim('Server not running — task saved to disk. Start the server then run your agent.');
      dim('When done: mycelium task done');
      log('');
    }
  });

// ── mycelium history [path] ───────────────────────────────────────────────────

program
  .command('history [path]')
  .description('Show session history')
  .option('-n, --limit <n>', 'Number of sessions to show', '10')
  .action((targetPath: string | undefined, opts: { limit: string }) => {
    const root       = resolveRoot(targetPath);
    const storageDir = path.join(root, '.mycelium');
    const limit      = parseInt(opts.limit, 10);
    header();

    // Try session-based history first
    const sessionsPath = path.join(storageDir, 'sessions.json');
    if (fs.existsSync(sessionsPath)) {
      const sm       = new SessionManager(root, storageDir);
      const sessions = sm.getSessions(limit);
      const active   = sm.getActiveSession();

      if (active) {
        log(`  ${C.bold}Active task:${C.reset} "${active.task}"  ${C.gray}${formatDuration(Date.now() - active.startedAt)} running${C.reset}\n`);
      }

      if (sessions.length === 0 && !active) {
        dim('No sessions recorded yet.');
        dim('Start one: mycelium task "your task description"');
        return;
      }

      for (const s of sessions) {
        const icon   = s.status === 'complete' ? `${C.green}✓${C.reset}` : `${C.gray}✕${C.reset}`;
        const dur    = s.result?.durationMs ? C.gray + ' · ' + formatDuration(s.result.durationMs) + C.reset : '';
        const when   = s.result?.completedAt ? C.gray + ' · ' + timeAgo(s.result.completedAt) + C.reset : '';
        const total  = (s.result?.filesChanged?.length ?? 0) + (s.result?.filesAdded?.length ?? 0);
        log(`  ${icon} ${C.bold}"${s.task}"${C.reset}${dur}${when}`);
        if (s.result && (s.result.totalLinesAdded || s.result.totalLinesRemoved)) {
          log(`     ${C.gray}${total} file${total !== 1 ? 's' : ''} · ${C.green}+${s.result.totalLinesAdded}${C.reset} ${C.red}-${s.result.totalLinesRemoved}${C.reset}`);
        }
        if (s.result?.filesAdded?.length) {
          for (const f of s.result.filesAdded.slice(0, 3))
            log(`     ${C.green}+${C.reset} ${C.gray}${f}${C.reset}`);
        }
        if (s.result?.filesChanged?.length) {
          for (const f of s.result.filesChanged.slice(0, 4)) {
            const c = s.result.changes?.[f];
            const d = c ? (c.delta >= 0 ? `${C.green}+${c.delta}${C.reset}` : `${C.red}${c.delta}${C.reset}`) : '';
            log(`     ${C.yellow}~${C.reset} ${C.gray}${f}${C.reset}  ${d}`);
          }
          if (s.result.filesChanged.length > 4) dim(`     + ${s.result.filesChanged.length - 4} more files`);
        }
        log('');
      }
      return;
    }

    // Fall back to legacy ChangeLogger format
    const { logger } = initProjectDir(root);
    const summary    = logger.getSummary();
    log(`  ${C.bold}Active task:${C.reset} ${summary.activeTask} ${C.gray}(${summary.activeAgent})${C.reset}\n`);
    for (const group of summary.taskHistory.slice(0, 5)) {
      log(`  ${C.bold}${group.task}${C.reset} ${C.gray}· ${group.agent} · ${group.filesChanged} files${C.reset}`);
      const entries = summary.recentChanges.filter((e: any) => e.taskDescription === group.task && e.agentTag === group.agent).slice(0, 5);
      for (const e of entries) {
        const color = e.changeType === 'created' ? C.green : e.changeType === 'deleted' ? C.yellow : C.cyan;
        log(`    ${color}${e.changeType.padEnd(8)}${C.reset} ${C.gray}${e.filePath}  ${timeAgo(e.timestamp)}${C.reset}`);
      }
      log('');
    }
  });

// ── mycelium search <query> ───────────────────────────────────────────────────

program
  .command('search <query>')
  .description('Search the codebase graph')
  .option('-p, --path <path>', 'Project path', '.')
  .option('-n, --limit <n>', 'Max results', '10')
  .action((query: string, opts: { path: string; limit: string }) => {
    const root = resolveRoot(opts.path);
    const { store } = initProjectDir(root);
    const results = store.search(query, undefined, parseInt(opts.limit, 10));
    if (results.length === 0) { log(`  ${C.yellow}No results for "${query}"${C.reset}`); return; }
    log(`\n  ${C.bold}Results for "${query}"${C.reset}  ${C.gray}(${results.length})${C.reset}\n`);
    for (const r of results) {
      log(`  ${C.cyan}${r.path}${C.reset}`);
      if (r.description) log(`  ${C.gray}${r.description}${C.reset}`);
      if (r.tags.length) log(`  ${r.tags.map(t => `${C.purple}#${t}${C.reset}`).join(' ')}`);
      log('');
    }
  });

// ── mycelium status [path] ────────────────────────────────────────────────────

program
  .command('status [path]')
  .description('Show graph statistics')
  .action((targetPath: string | undefined) => {
    header();
    const root = resolveRoot(targetPath);
    const { store } = initProjectDir(root);
    const stats = store.getStats();
    log(`  ${C.bold}Project${C.reset}  ${C.gray}${root}${C.reset}`);
    log(`  ${C.bold}Files${C.reset}    ${stats.fileCount}`);
    log(`  ${C.bold}Edges${C.reset}    ${stats.edgeCount}`);
    log(`  ${C.bold}Nodes${C.reset}    ${stats.nodeCount}`);
    log(`  ${C.bold}Pending${C.reset}  ${stats.unsummarized} files need summarization`);
    const apiKey = getApiKey();
    log(`  ${C.bold}API key${C.reset}  ${apiKey ? `${C.green}set${C.reset}` : `${C.yellow}not set${C.reset} (run mycelium key <key>)`}`);
    // Show active session if one exists
    const storageDir   = path.join(root, '.mycelium');
    const sessionsPath = path.join(storageDir, 'sessions.json');
    if (fs.existsSync(sessionsPath)) {
      const sm     = new SessionManager(root, storageDir);
      const active = sm.getActiveSession();
      if (active) log(`  ${C.bold}Task${C.reset}     ${C.green}"${active.task}"${C.reset} ${C.gray}(${formatDuration(Date.now() - active.startedAt)} running)${C.reset}`);
    }
  });

// ── mycelium debug [path] ─────────────────────────────────────────────────────

program
  .command('debug [path]')
  .description('Show raw edge breakdown to diagnose connection issues')
  .action(async (targetPath: string | undefined) => {
    const root = resolveRoot(targetPath);
    const { store } = initProjectDir(root);
    const stats = store.getStats();
    header();
    log(`  ${C.bold}Files:${C.reset}       ${stats.fileCount}`);
    log(`  ${C.bold}Nodes total:${C.reset} ${stats.nodeCount}`);
    log(`  ${C.bold}Import edges:${C.reset} ${stats.importEdges ?? 0} ${C.gray}(file → file, shown in graph)${C.reset}`);
    log(`  ${C.bold}Export edges:${C.reset} ${stats.exportEdges ?? 0} ${C.gray}(file → symbol, not shown)${C.reset}`);
    log('');
    const graph       = store.getSubGraph();
    const importEdges = graph.edges.filter(e => e.kind === 'imports').slice(0, 8);
    if (importEdges.length === 0) {
      warn('Zero import edges detected. Running deep resolution test...');
      log('');
      const sampleNodes = graph.nodes.filter(n => n.kind === 'file').slice(0, 8);
      log(`  ${C.bold}Sample node IDs in graph:${C.reset}`);
      sampleNodes.forEach(n => log(`  ${C.gray}  "${n.id}"${C.reset}`));
      log('');
      const testPaths = ['lib/auth-context','lib/auth-context.tsx','components/Navbar','components/Navbar.tsx','app/layout','app/layout.tsx'];
      log(`  ${C.bold}Resolution test:${C.reset}`);
      for (const tp of testPaths) {
        const result = store.resolveNodeId(tp);
        log(`  ${C.gray}  "${tp}" → ${result ? C.green + '"' + result + '"' + C.gray : C.yellow + 'null' + C.gray}${C.reset}`);
      }
      log('');
      const storeAny = store as any;
      const allKeys  = Object.keys(storeAny.data.nodes);
      ['lib/', 'components/'].forEach(prefix => {
        const keys = allKeys.filter(k => k.startsWith(prefix)).slice(0, 5);
        log(`  ${C.bold}Actual keys (${prefix}):${C.reset}`);
        keys.forEach(k => log(`  ${C.gray}  "${k}"${C.reset}`));
      });
    } else {
      log(`  ${C.bold}Sample import edges:${C.reset}`);
      importEdges.forEach(e => log(`  ${C.gray}  ${e.from} → ${e.to}${C.reset}`));
    }
  });

// ── mycelium key ─────────────────────────────────────────────────────────────

program
  .command('key')
  .description('Save API keys globally (~/.mycelium/config.json)')
  .argument('[anthropicKey]', 'Anthropic API key (sk-ant-...)')
  .option('--openai <key>', 'OpenAI API key for semantic embeddings (sk-...)')
  .action((anthropicKey: string | undefined, opts: { openai?: string }) => {
    if (anthropicKey) {
      if (!anthropicKey.startsWith('sk-ant-')) { warn('Anthropic key should start with sk-ant-'); return; }
      saveGlobalConfig({ apiKey: anthropicKey }); ok(`Anthropic key saved to ${GLOBAL_CONFIG_FILE}`);
    }
    if (opts.openai) {
      if (!opts.openai.startsWith('sk-')) { warn('OpenAI key should start with sk-'); return; }
      saveGlobalConfig({ openAiKey: opts.openai }); ok(`OpenAI key saved to ${GLOBAL_CONFIG_FILE}`); ok('Run mycelium embed <path> to generate semantic embeddings');
    }
    if (!anthropicKey && !opts.openai) {
      const cfg = getGlobalConfig() as any;
      log(`  Anthropic key: ${cfg.apiKey    ? C.green + 'set' + C.reset : C.yellow + 'not set' + C.reset}`);
      log(`  OpenAI key:    ${cfg.openAiKey ? C.green + 'set' + C.reset : C.yellow + 'not set (optional, enables semantic search)' + C.reset}`);
    }
  });

// ── mycelium embed [path] ─────────────────────────────────────────────────────

program
  .command('embed [path]')
  .description('Generate semantic embeddings for all summarized files')
  .action(async (targetPath: string | undefined) => {
    header();
    const root      = resolveRoot(targetPath);
    const { store } = initProjectDir(root);
    const openAiKey = getOpenAiKey();
    if (!openAiKey) { warn('No OpenAI key. Run: mycelium key --openai sk-...'); process.exit(1); }
    const dir     = path.join(root, '.mycelium');
    const engine  = initEngine(dir, openAiKey);
    const toEmbed = store.getFileNodes().filter(n => n.description).map(n => ({ id: n.id, text: EmbeddingEngine.buildText(n) }));
    if (toEmbed.length === 0) { warn('No summarized files found. Run mycelium init first.'); process.exit(1); }
    info(`Embedding ${toEmbed.length} files...`);
    const newCount = await engine.embedNodes(toEmbed, (done, total) => { process.stdout.write(`\r  ${C.cyan}◆${C.reset} ${done}/${total}`); });
    process.stdout.write('\n');
    const pruned = engine.pruneOrphans(new Set(store.getFileNodes().map(n => n.id)));
    ok(`${newCount} new embeddings generated`);
    ok(`${toEmbed.length - newCount} already cached`);
    if (pruned > 0) ok(`${pruned} stale embeddings removed`);
    ok('Semantic search now active on /search and /preflight');
  });

// ─── Shared helpers ───────────────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60000)    return 'just now';
  if (d < 3600000)  return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return `${Math.floor(d / 86400000)}d ago`;
}

program.parse(process.argv);