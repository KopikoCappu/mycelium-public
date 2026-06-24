import * as fs from 'fs';
import * as path from 'path';
import type { GraphStore } from './graph/store';
import type { GraphMemConfig } from './graph/schema';

// ─── Bootstrap ────────────────────────────────────────────────────────────────
// Called after first scan completes.
// Writes CLAUDE.md and .mcp.json into the project root so agents find them
// automatically without any manual setup.

export function bootstrapAgentFiles(
  workspaceRoot: string,
  store: GraphStore,
  config: GraphMemConfig
): void {
  writeMcpJson(workspaceRoot, config);
  writeClaudeMd(workspaceRoot, store, config);
}

// ─── .mcp.json ────────────────────────────────────────────────────────────────
// Claude Code reads this file and auto-discovers MCP servers in the project.
// Once this exists, agents get /search, /preflight, /dependencies, /history
// as native tools without being told anything.

function writeMcpJson(workspaceRoot: string, config: GraphMemConfig): void {
  const mcpPath = path.join(workspaceRoot, '.mcp.json');

  const mcpConfig = {
    mcpServers: {
      graphmem: {
        type: 'http',
        url: `http://localhost:${config.mcp.port}`,
        description: 'GraphMem codebase memory. Query before touching any files.'
      }
    }
  };

  // Never overwrite a user-edited .mcp.json -- merge instead
  if (fs.existsSync(mcpPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      // Only add graphmem if it's not already there
      if (!existing?.mcpServers?.graphmem) {
        existing.mcpServers = existing.mcpServers ?? {};
        existing.mcpServers.graphmem = mcpConfig.mcpServers.graphmem;
        fs.writeFileSync(mcpPath, JSON.stringify(existing, null, 2), 'utf8');
        console.log('[GraphMem] Updated .mcp.json with graphmem server');
      }
    } catch { /* malformed .mcp.json, leave it alone */ }
    return;
  }

  fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2), 'utf8');
  console.log('[GraphMem] Created .mcp.json');
}

// ─── CLAUDE.md ────────────────────────────────────────────────────────────────
// Claude Code reads this as a system prompt for the project.
// We write a GraphMem section that tells the agent exactly how to use the graph.
// If CLAUDE.md already exists we append our section rather than overwriting.

const GRAPHMEM_SECTION_START = '<!-- graphmem:start -->';
const GRAPHMEM_SECTION_END   = '<!-- graphmem:end -->';

function writeClaudeMd(
  workspaceRoot: string,
  store: GraphStore,
  config: GraphMemConfig
): void {
  const claudePath = path.join(workspaceRoot, 'CLAUDE.md');
  const stats = store.getStats();
  const teams = Object.keys(config.teams);
  const port  = config.mcp.port;

  const section = buildGraphMemSection(stats, teams, port);

  if (fs.existsSync(claudePath)) {
    let existing = fs.readFileSync(claudePath, 'utf8');

    // Replace our section if it already exists, otherwise append
    const startIdx = existing.indexOf(GRAPHMEM_SECTION_START);
    const endIdx   = existing.indexOf(GRAPHMEM_SECTION_END);

    if (startIdx !== -1 && endIdx !== -1) {
      // Update the existing section
      existing =
        existing.slice(0, startIdx) +
        section +
        existing.slice(endIdx + GRAPHMEM_SECTION_END.length);
    } else {
      // Append to whatever's already there
      existing = existing.trimEnd() + '\n\n' + section;
    }

    fs.writeFileSync(claudePath, existing, 'utf8');
    console.log('[GraphMem] Updated CLAUDE.md');
  } else {
    // First time -- write the whole file
    fs.writeFileSync(claudePath, section, 'utf8');
    console.log('[GraphMem] Created CLAUDE.md');
  }
}

function buildGraphMemSection(
  stats: { fileCount: number; nodeCount: number; edgeCount: number },
  teams: string[],
  port: number
): string {
  const teamList = teams.map(t => `  - \`${t}\``).join('\n');

  return `${GRAPHMEM_SECTION_START}

# 🍄 Mycelium — Codebase Memory

This project uses **Mycelium** for AI agent memory and task tracking.
Graph: **${stats.fileCount} files** · **${stats.edgeCount} edges** · AI descriptions on every node.

> **You are not the first agent here. Read before you touch anything.**

---

## Mandatory workflow — follow this every single time

### Step 0 — Start a session

\`\`\`bash
mycelium task "describe exactly what you are about to do"
\`\`\`

This takes a snapshot of the codebase so every file you touch gets recorded with a full diff. Skip this and your work goes untracked.

---

### Step 1 — Preflight your task

\`\`\`bash
curl "http://localhost:${port}/preflight?task=DESCRIBE_YOUR_TASK_IN_PLAIN_ENGLISH"
\`\`\`

Returns the 4–8 files most relevant to your task. **Read only these files.** Do not explore the codebase blindly. The graph knows what's relevant — trust it.

---

### Step 2 — Check what previous agents did

\`\`\`bash
curl "http://localhost:${port}/history"
\`\`\`

See every session that ran before you. What files were touched, how many lines changed, and an AI summary of what was done. Never repeat work or undo someone else's progress.

---

### Step 3 — Check blast radius before modifying any function

\`\`\`bash
curl "http://localhost:${port}/xref?file=src/auth/token.ts&fn=refreshToken"
\`\`\`

Replace the file and function name with whatever you're about to change. This returns every caller and callee. If something imports or calls what you're modifying, read that file too before changing the signature.

---

### Step 4 — Make your changes

Only now open files and make edits. Stay within the files preflight returned unless xref revealed additional callers you need to update.

---

### Step 5 — End the session

\`\`\`bash
mycelium task done
\`\`\`

This computes the full diff — every file changed, lines added and removed, recorded in session history. The next agent will see exactly what you did.

---

## Other useful queries

\`\`\`bash
# Semantic search across all file descriptions
curl "http://localhost:${port}/search?q=stripe+webhook"

# What a file imports and what imports it
curl "http://localhost:${port}/dependencies?file=src/payments/stripe.ts"

# Full dependency graph as JSON
curl "http://localhost:${port}/graph"

# Single file details
curl "http://localhost:${port}/node/src%2Fapi%2Forders.ts"

# Server health and graph stats
curl "http://localhost:${port}/status"
\`\`\`

---

## Rules — non-negotiable

| # | Rule |
|---|------|
| 1 | Run \`mycelium task\` before anything else |
| 2 | Run \`/preflight\` before reading any file |
| 3 | Run \`/history\` if continuing or building on existing work |
| 4 | Run \`/xref\` before modifying any function that has callers |
| 5 | Read only the files preflight returned — trust the graph |
| 6 | Run \`mycelium task done\` when finished |
${teamList.length > 0 ? `\n## Team lenses\n${teamList}` : ''}

---

## Why this matters

Every agent that skips preflight reads 10× more files than necessary and burns through context that could be used for actual work. Every agent that skips \`mycelium task done\` leaves the next agent blind to what changed.

The graph viewer at **http://localhost:${port}/ui** shows the full dependency map of this codebase. Open it if you want to understand the structure visually before starting.

${GRAPHMEM_SECTION_END}`;
}
