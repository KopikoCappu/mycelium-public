import * as fs from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChangeEntry {
  id: string;
  timestamp: number;
  filePath: string;
  taskDescription: string;   // what the agent/human said they were doing
  agentTag: string;          // "human" | "claude-code" | "cursor" | custom
  changeType: 'created' | 'modified' | 'deleted';
  linesChanged?: number;
  summary?: string;          // AI-generated summary of what changed (filled async)
}

export interface HistoryData {
  entries: ChangeEntry[];
  activeTask: string;        // current task description, applied to all saves
  activeAgent: string;       // who is doing the work right now
}

// ─── Logger ───────────────────────────────────────────────────────────────────

export class ChangeLogger {
  private data: HistoryData;
  private filePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(historyPath: string) {
    this.filePath = historyPath;
    this.data = this.load();
  }

  private load(): HistoryData {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch { /* start fresh */ }
    return { entries: [], activeTask: 'General development', activeAgent: 'human' };
  }

  private save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    }, 1000);
  }

  // ── Task management ───────────────────────────────────────────────────────

  setActiveTask(description: string, agent = 'human'): void {
    this.data.activeTask = description;
    this.data.activeAgent = agent;
    this.save();
  }

  getActiveTask(): { task: string; agent: string } {
    return { task: this.data.activeTask, agent: this.data.activeAgent };
  }

  // ── Log a file change ─────────────────────────────────────────────────────

  logChange(
    filePath: string,
    changeType: ChangeEntry['changeType'],
    linesChanged?: number
  ): ChangeEntry {
    const entry: ChangeEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      filePath,
      taskDescription: this.data.activeTask,
      agentTag: this.data.activeAgent,
      changeType,
      linesChanged,
    };

    this.data.entries.unshift(entry); // newest first

    // Keep last 1000 entries
    if (this.data.entries.length > 1000) {
      this.data.entries = this.data.entries.slice(0, 1000);
    }

    this.save();
    return entry;
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  getRecent(limit = 50): ChangeEntry[] {
    return this.data.entries.slice(0, limit);
  }

  getForFile(filePath: string): ChangeEntry[] {
    return this.data.entries.filter(e => e.filePath === filePath);
  }

  getForTask(taskDescription: string): ChangeEntry[] {
    return this.data.entries.filter(e =>
      e.taskDescription.toLowerCase().includes(taskDescription.toLowerCase())
    );
  }

  // Group by task -- useful for the timeline view
  getByTask(): Array<{ task: string; agent: string; entries: ChangeEntry[]; lastActive: number }> {
    const groups = new Map<string, { task: string; agent: string; entries: ChangeEntry[]; lastActive: number }>();

    for (const entry of this.data.entries) {
      const key = `${entry.agentTag}::${entry.taskDescription}`;
      if (!groups.has(key)) {
        groups.set(key, { task: entry.taskDescription, agent: entry.agentTag, entries: [], lastActive: 0 });
      }
      const group = groups.get(key)!;
      group.entries.push(entry);
      group.lastActive = Math.max(group.lastActive, entry.timestamp);
    }

    return Array.from(groups.values()).sort((a, b) => b.lastActive - a.lastActive);
  }

  // HTTP-ready summary for MCP server
  getSummary() {
    const recent = this.getRecent(20);
    const byTask = this.getByTask().slice(0, 10);
    return {
      activeTask: this.data.activeTask,
      activeAgent: this.data.activeAgent,
      totalChanges: this.data.entries.length,
      recentChanges: recent,
      taskHistory: byTask.map(g => ({
        task: g.task,
        agent: g.agent,
        filesChanged: [...new Set(g.entries.map(e => e.filePath))].length,
        changeCount: g.entries.length,
        lastActive: g.lastActive,
      })),
    };
  }
}
