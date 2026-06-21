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
## Mycelium — Codebase Memory

This project uses **Mycelium** for AI agent memory.
Graph: **${stats.fileCount} files**, **${stats.edgeCount} edges**, AI descriptions on every node.

---

### MANDATORY: Do this before touching ANY file

**Step 1 — Preflight your task**
\`\`\`bash
curl "http://localhost:${port}/preflight?task=DESCRIBE_YOUR_TASK_IN_PLAIN_ENGLISH"
\`\`\`
Read ONLY the files returned. Do not explore the codebase blindly. The graph knows what's relevant.

**Step 2 — Check agent history**
\`\`\`bash
curl "http://localhost:${port}/history"
\`\`\`
See what previous agents changed. Never repeat work or undo someone else's progress.

**Step 3 — Before modifying a function, check its impact**
\`\`\`bash
curl "http://localhost:${port}/xref?file=src/auth/token.ts&fn=refreshToken"
\`\`\`
This shows every caller of that function and what it calls. Know the blast radius before changing anything.

**Step 4 — Make your changes**
Only now open files and make edits.

**Step 5 — After finishing**
Write a one-sentence summary of what you changed as a comment or in your response.
The next agent will read it.

---

### Other useful queries

\`\`\`bash
# Semantic search
curl "http://localhost:${port}/search?q=stripe+webhook"

# What a file imports and what imports it
curl "http://localhost:${port}/dependencies?file=src/payments/stripe.ts"

# Full graph
curl "http://localhost:${port}/graph"
\`\`\`

### Team lenses: ${teamList.length > 0 ? '' : 'none configured'}
${teamList}

### Rules (non-negotiable)
1. /preflight before any file read. No exceptions.
2. /history if continuing existing work.
3. /xref before modifying any function with callers.
4. Read only preflight results. Trust the graph.
5. Summarize what you did when finished.
${GRAPHMEM_SECTION_END}`;
}
