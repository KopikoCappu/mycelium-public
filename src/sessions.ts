/**
 * sessions.ts — Task session management for Mycelium
 *
 * Tracks bounded work sessions: start snapshot → agent works → complete snapshot → diff.
 * Stores results in .mycelium/sessions.json alongside the graph data.
 *
 * Integration:
 *   import { SessionManager } from './sessions';
 *   const sessions = new SessionManager(projectRoot, storageDir);
 *   // Pass `sessions` to your server route setup and CLI handlers.
 */

import fs   from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface FileSnapshot {
  lines: number;  // line count at snapshot time
  mtime: number;  // fs mtime in ms — used to detect changes without re-reading
}

export interface FileChange {
  status:      'added' | 'modified' | 'deleted';
  linesBefore: number;
  linesAfter:  number;
  delta:       number;  // positive = lines added, negative = lines removed
  diff?:       string;  // actual changed lines from git diff, captured at task done
}

export interface SessionResult {
  completedAt:       number;
  durationMs:        number;
  filesAdded:        string[];
  filesChanged:      string[];
  filesDeleted:      string[];
  changes:           Record<string, FileChange>;  // relative path → change
  totalLinesAdded:   number;
  totalLinesRemoved: number;
}

export interface TaskSession {
  id:             string;
  task:           string;
  status:         'active' | 'complete' | 'abandoned';
  startedAt:      number;
  projectRoot:    string;
  snapshot:       Record<string, FileSnapshot>;  // relative path → snapshot
  preflightFiles: string[];   // files returned by /preflight during this session
  result?:        SessionResult;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Count lines in a file. Fast — reads once, counts newlines. */
function countLines(absPath: string): number {
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

/**
 * Capture the git diff for a single file relative to HEAD.
 * For untracked/new files, falls back to --no-index diff against /dev/null.
 * Returns null if git isn't available, the repo isn't initialized, or there's no diff.
 */
function getGitDiff(projectRoot: string, rel: string): string | null {
  const opts = {
    cwd:      projectRoot,
    encoding: 'utf8' as const,
  };

  try {
    const out = execSync(`git diff HEAD -- "${rel}"`, opts).trim();
    if (out) return out;
  } catch {
    // Not a git repo or HEAD doesn't exist yet
  }

  try {
    execSync(`git diff --no-index /dev/null "${rel}"`, opts);
    return null;
  } catch (e: any) {
    const out = (e.stdout ?? '').trim();
    return out || null;
  }
}

/** Format milliseconds as "2h 14m", "33m", "45s" etc. */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/**
 * Walk all source files under root, respecting common ignore dirs.
 * Returns absolute paths.
 */
function walkSourceFiles(
  root:        string,
  ignoreDirs = ['node_modules', '.git', 'dist', 'build', '.next', '.mycelium',
                'coverage', '__pycache__', '.cache', 'vendor', '.turbo'],
): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      // Skip hidden dirs (except root-level .git which is already ignored above)
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (ignoreDirs.includes(entry.name)) continue;

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  }

  walk(root);
  return results;
}

// ─── SessionManager ────────────────────────────────────────────────────────────

export class SessionManager {
  private sessionsPath: string;
  private sessions:     TaskSession[] = [];
  private active:       TaskSession | null = null;

  constructor(
    private projectRoot: string,
    storageDir:          string,
  ) {
    this.sessionsPath = path.join(storageDir, 'sessions.json');
    this._load();
  }

  // ── Persistence ──────────────────────────────────────────────────────────────

  private _load() {
    try {
      const raw = fs.readFileSync(this.sessionsPath, 'utf8');
      this.sessions = JSON.parse(raw);
      // Restore active session if one was in progress when server last stopped
      this.active = this.sessions.find(s => s.status === 'active') ?? null;
    } catch {
      this.sessions = [];
      this.active   = null;
    }
  }

  private _save() {
    try {
      fs.writeFileSync(this.sessionsPath, JSON.stringify(this.sessions, null, 2));
    } catch (e) {
      console.error('[mycelium] Failed to save sessions:', e);
    }
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────────

  /**
   * Take a lightweight snapshot of all source files.
   *
   * If graphNodes is provided (from the existing Mycelium graph), we use
   * its cached line counts so we don't need to re-read every file on disk —
   * making task start nearly instant even on large codebases.
   *
   * We still stat every file for mtime, which is the fast syscall we need
   * to detect changes at task complete.
   */
  private _takeSnapshot(
    graphNodes?: Array<{ id: string; lineCount?: number; lines?: number }>,
  ): Record<string, FileSnapshot> {
    const snapshot: Record<string, FileSnapshot> = {};

    // Build a lookup from graph data if available
    const graphLineCount = new Map<string, number>();
    if (graphNodes) {
      for (const n of graphNodes) {
        const lc = n.lineCount ?? n.lines;
        if (lc != null) graphLineCount.set(n.id, lc);
      }
    }

    const absFiles = walkSourceFiles(this.projectRoot);
    for (const absPath of absFiles) {
      const rel = path.relative(this.projectRoot, absPath).replace(/\\/g, '/');
      try {
        const stat  = fs.statSync(absPath);
        const lines = graphLineCount.get(rel) ?? countLines(absPath);
        snapshot[rel] = { lines, mtime: stat.mtimeMs };
      } catch {
        // File disappeared between walk and stat — skip
      }
    }

    return snapshot;
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Start a new task session.
   * If a session is already active, it gets abandoned first.
   */
  startSession(
    task:       string,
    graphNodes?: Array<{ id: string; lineCount?: number; lines?: number }>,
  ): TaskSession {
    // Abandon any in-progress session without recording it
    if (this.active) {
      this.active.status = 'abandoned';
    }

    const session: TaskSession = {
      id:             randomUUID(),
      task,
      status:         'active',
      startedAt:      Date.now(),
      projectRoot:    this.projectRoot,
      snapshot:       this._takeSnapshot(graphNodes),
      preflightFiles: [],
    };

    // Prepend so newest is first
    this.sessions.unshift(session);
    this.active = session;
    this._save();

    return session;
  }

  /**
   * Complete the active session: compute file diffs and store result.
   * Returns the completed session, or null if no session was active.
   */
  completeSession(): TaskSession | null {
    if (!this.active) return null;

    const session = this.active;
    const now     = Date.now();

    // Re-snapshot the project to find what changed
    const after = this._takeSnapshot();

    const allPaths = new Set([
      ...Object.keys(session.snapshot),
      ...Object.keys(after),
    ]);

    const changes:      Record<string, FileChange> = {};
    const filesAdded:   string[] = [];
    const filesChanged: string[] = [];
    const filesDeleted: string[] = [];
    let totalAdded = 0, totalRemoved = 0;

    for (const rel of allPaths) {
      const before = session.snapshot[rel];
      const curr   = after[rel];

      if (!before && curr) {
        // New file created during session
        const newDiff = getGitDiff(this.projectRoot, rel);
        changes[rel] = {
          status: 'added', linesBefore: 0, linesAfter: curr.lines, delta: curr.lines,
          ...(newDiff ? { diff: newDiff } : {}),
        };
        filesAdded.push(rel);
        totalAdded += curr.lines;

      } else if (before && !curr) {
        // File deleted during session
        changes[rel] = { status: 'deleted', linesBefore: before.lines, linesAfter: 0, delta: -before.lines };
        filesDeleted.push(rel);
        totalRemoved += before.lines;

      } else if (before && curr && curr.mtime !== before.mtime) {
        // File was touched — re-read to get accurate current line count
        // (snapshot only uses cached lines; the real count may differ)
        const absPath   = path.join(this.projectRoot, rel);
        const realLines = countLines(absPath) || curr.lines;
        const delta     = realLines - before.lines;
        // Capture actual diff at completion time so summarization is accurate
        const diff      = getGitDiff(this.projectRoot, rel);

        changes[rel] = {
          status:      'modified',
          linesBefore: before.lines,
          linesAfter:  realLines,
          delta,
          ...(diff ? { diff } : {}),
        };
        filesChanged.push(rel);
        if (delta > 0) totalAdded   += delta;
        else           totalRemoved += Math.abs(delta);
      }
      // Unchanged files (same mtime) → omit from result entirely
    }

    session.status = 'complete';
    session.result = {
      completedAt:       now,
      durationMs:        now - session.startedAt,
      filesAdded,
      filesChanged,
      filesDeleted,
      changes,
      totalLinesAdded:   totalAdded,
      totalLinesRemoved: totalRemoved,
    };

    this.active = null;
    this._save();
    return session;
  }

  /**
   * Abandon the active session without computing or storing any diff.
   */
  abandonSession(): TaskSession | null {
    if (!this.active) return null;
    this.active.status = 'abandoned';
    const s     = this.active;
    this.active = null;
    this._save();
    return s;
  }

  /** Register files returned by /preflight to the active session. */
  addPreflightFiles(files: string[]) {
    if (!this.active) return;
    const existing = new Set(this.active.preflightFiles);
    for (const f of files) existing.add(f);
    this.active.preflightFiles = [...existing];
    this._save();
  }

  getActiveSession(): TaskSession | null { return this.active; }

  getSessions(limit = 30): TaskSession[] {
    return this.sessions.slice(0, limit);
  }

  /**
   * Reload from disk. Call this at the top of read operations in the server
   * so CLI-written sessions are always picked up without a restart.
   */
  refresh(): void {
    this._load();
  }

  /** Cache an AI-generated summary string against a session by ID. */
  setSummary(sessionId: string, summary: string): void {
    const s = this.sessions.find(s => s.id === sessionId);
    if (!s) return;
    (s as any).summary = summary;
    this._save();
  }

  /** Return a cached summary if one exists. */
  getSummary(sessionId: string): string | null {
    const s = this.sessions.find(s => s.id === sessionId);
    return s ? ((s as any).summary ?? null) : null;
  }

  // ── History endpoint response shape ──────────────────────────────────────────

  /**
   * Returns the JSON shape expected by the UI's /history endpoint.
   * The UI's loadHistory() reads this format.
   */
  toHistoryResponse() {
    const active   = this.active;
    const sessions = this.sessions
      .filter(s => s.status !== 'active')
      .slice(0, 30)
      .map(s => ({
        id:                s.id,
        task:              s.task,
        status:            s.status,
        startedAt:         s.startedAt,
        completedAt:       s.result?.completedAt,
        durationMs:        s.result?.durationMs,
        totalLinesAdded:   s.result?.totalLinesAdded   ?? 0,
        totalLinesRemoved: s.result?.totalLinesRemoved ?? 0,
        filesChanged:      s.result?.filesChanged  ?? [],
        filesAdded:        s.result?.filesAdded    ?? [],
        filesDeleted:      s.result?.filesDeleted  ?? [],
        changes:           s.result?.changes       ?? {},
        preflightFiles:    s.preflightFiles,
        // after `preflightFiles: s.preflightFiles,`
        summary: (s as any).summary ?? null,
        
      }));

    return {
      activeTask: active?.task ?? null,
      activeSession: active ? {
        id:            active.id,
        task:          active.task,
        startedAt:     active.startedAt,
        durationMs:    Date.now() - active.startedAt,
        filesInScope:  active.preflightFiles.length,
      } : null,
      sessions,
      // Legacy key — keeps the old flat history UI working during transition
      recentChanges: sessions.flatMap(s =>
        Object.entries(s.changes ?? {}).map(([file, c]) => ({
          file,
          task:        s.task,
          timestamp:   s.completedAt,
          linesAdded:  c.delta > 0 ? c.delta   : 0,
          linesRemoved: c.delta < 0 ? -c.delta : 0,
          linesBefore: c.linesBefore,
          linesAfter:  c.linesAfter,
          description: `${c.status} · ${c.linesAfter} lines`,
        }))
      ),
    };
  }
}