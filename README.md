# Mycelium

**Codebase memory for AI coding agents**

---

## The problem

AI coding agents (Claude Code, Cursor, Copilot) read 30–40 files before touching anything. They have no persistent memory of your codebase between sessions. Every task starts from zero.

## What Mycelium does

One command scans your project, builds a semantic dependency graph, and starts an HTTP server. Your agent calls `/preflight?task=add stripe checkout` and gets back the 4–6 files it actually needs — not 40.

```
Without Mycelium:  agent reads 40 files  →  ~32,000 tokens
With Mycelium:     agent reads 4 files   →  ~3,200 tokens
```

Mycelium also tracks **work sessions** — you declare what you're building, let your agent run, then declare done. Mycelium computes exactly what changed, which files were touched, and how many lines were added or removed.

---

## Install

```bash
npm install -g @kopikocappu/mycelium
```

Set your Anthropic API key (used for AI file descriptions):

```bash
mycelium key sk-ant-...
```

Optionally set an OpenAI key for semantic search (highly recommended):

```bash
mycelium key --openai sk-...
```

---

## Quick start

```bash
cd your-project

# 1. Scan, describe, and start the server
mycelium init

# 2. Open the graph viewer
# → http://localhost:47821/ui

# 3. Start a task session before using your agent
mycelium task "add stripe checkout"

# 4. Use your agent normally — it calls /preflight automatically
# 5. When done:
mycelium task done
```

---

## CLI reference

### `mycelium init [path]`

Scans your codebase, generates AI descriptions for every file, builds the dependency graph, and starts the MCP server. Run this first on any new project.

```bash
mycelium init                    # current directory
mycelium init ./my-project       # specific path
mycelium init --port 4000        # custom port (default: 47821)
mycelium init --force            # clear and rebuild from scratch
mycelium init --no-serve         # scan only, don't start server
mycelium init --no-watch         # don't watch for file changes
```

What it does:
1. Detects source file patterns (`.ts`, `.tsx`, `.js`, `.py`, etc.)
2. Parses every file for imports, exports, function definitions
3. Resolves import aliases (`@/components/X` → `src/components/X.tsx`)
4. Generates Claude Haiku descriptions for each file with hash-based caching
5. Generates OpenAI embeddings if key is set
6. Writes `CLAUDE.md` and `.mcp.json` to bootstrap agent configuration
7. Starts the MCP HTTP server
8. Starts a file watcher that updates the graph on save

---

### `mycelium serve [path]`

Starts the server without rescanning. Use this if you've already run `init` and just want the server back up.

```bash
mycelium serve
mycelium serve --port 4000
mycelium serve --no-watch        # no file watcher
```

---

### `mycelium scan [path]`

Re-scans file structure and updates the graph without regenerating AI descriptions. Fast — only processes changed files.

```bash
mycelium scan                    # incremental, only changed files
mycelium scan --clear            # clear graph and full rescan + redescribe
```

Use `--clear` after major refactors where file paths have changed significantly.

---

### `mycelium task "description"`

Start a new work session. Mycelium takes a lightweight snapshot of every source file (line count + last-modified time) so it can compute an exact diff when you finish.

```bash
mycelium task "add stripe checkout flow"
mycelium task "fix the auth timeout bug"
mycelium task "refactor payments module"
```

Output:
```
  ✓ Task started  snapshot: 312 files
  "add stripe checkout flow"

  Run your agent. When done: mycelium task done
```

---

### `mycelium task done`

Ends the active session. Walks your files, finds everything that changed since the snapshot, re-reads only those files, and computes the full diff.

```bash
mycelium task done
```

Output:
```
  ✓ Task complete  33m
  "add stripe checkout flow"

  3 files touched  +142 -5

  New files:
    + src/payments/stripe.ts (231 lines)
  Modified:
    ~ src/api/checkout.ts  89→121 lines  +32
    ~ src/config/env.ts    45→48 lines   +3
  
  Recorded in session history.
```

---

### `mycelium task status`

Shows the currently active task and how long it's been running.

```bash
mycelium task status
```

---

### `mycelium task abandon`

Drops the current session without recording anything.

```bash
mycelium task abandon
```

---

### `mycelium search <query>`

Searches the graph for files matching a natural language query. Uses semantic similarity if OpenAI embeddings are set up, keyword matching otherwise.

```bash
mycelium search "authentication"
mycelium search "stripe payment processing"
mycelium search "database connection" --limit 5
```

---

### `mycelium status [path]`

Shows graph statistics and configuration state.

```bash
mycelium status
```

```
  Project  /Users/you/my-project
  Files    312
  Edges    847
  Nodes    1,203
  Pending  0 files need summarization
  API key  set
  Task     "add stripe checkout" (12m running)
```

---

### `mycelium history [path]`

Shows completed session history with per-file change breakdowns.

```bash
mycelium history
mycelium history --limit 5
```

---

### `mycelium key [anthropicKey]`

Saves API keys globally to `~/.mycelium/config.json`. Keys are stored with `chmod 600` permissions.

```bash
mycelium key sk-ant-...                  # Anthropic key (for descriptions)
mycelium key --openai sk-...             # OpenAI key (for semantic search)
mycelium key                             # show current key status
```

---

### `mycelium embed [path]`

Generates or refreshes OpenAI semantic embeddings for all summarized files. Enables semantic search on `/preflight` and `/search`.

```bash
mycelium embed
```

Embeddings are cached — only new or changed files are re-embedded.

---

### `mycelium debug [path]`

Diagnoses connection issues. Shows node ID samples, import edge counts, and runs alias resolution tests. Use this if the graph shows files but no connections.

```bash
mycelium debug
```

---

## MCP server endpoints

The server runs at `http://localhost:47821` by default. All endpoints return JSON.

Your agent should be configured to call these via `.mcp.json` (auto-generated by `mycelium init`).

---

### `GET /preflight?task=<description>`

**The most important endpoint.** Pass a natural language description of what you're about to do. Returns the most relevant files to read, ranked by semantic similarity.

```
GET /preflight?task=add stripe checkout flow
```

```json
{
  "task": "add stripe checkout flow",
  "mode": "semantic",
  "files": [
    {
      "nodeId": "src/payments/index.ts",
      "score": 0.91,
      "reason": "semantic",
      "description": "Handles payment processing and Stripe integration"
    },
    {
      "nodeId": "src/api/checkout.ts",
      "score": 0.87,
      "reason": "semantic"
    }
  ],
  "tokensSaved": 7200,
  "contextSummary": "## Mycelium Pre-flight: ..."
}
```

**Agents should call this before touching any file.** The `contextSummary` field is a pre-formatted markdown block ready to paste into context.

Optional parameters:
- `?task=description&team=frontend` — filter to a specific team's file scope
- `?task=description&limit=10` — more results

---

### `GET /graph`

Full graph as JSON. Contains all nodes (files, functions, classes) and all edges (imports, calls, contains).

```
GET /graph
GET /graph?team=frontend
```

```json
{
  "nodes": [
    {
      "id": "src/payments/stripe.ts",
      "kind": "file",
      "name": "stripe.ts",
      "description": "Handles Stripe payment processing...",
      "tags": ["payments", "stripe", "api"],
      "lineCount": 231
    }
  ],
  "edges": [
    { "from": "src/api/checkout.ts", "to": "src/payments/stripe.ts", "kind": "imports" }
  ]
}
```

---

### `GET /dependencies?file=<path>`

Returns everything a specific file imports (depends on) and every file that imports it (dependents). Essential for understanding blast radius before editing.

```
GET /dependencies?file=src/payments/stripe.ts
```

```json
{
  "target": { "id": "src/payments/stripe.ts", ... },
  "dependsOn": [
    { "id": "src/config/env.ts", "kind": "file" }
  ],
  "usedBy": [
    { "id": "src/api/checkout.ts", "kind": "file" },
    { "id": "src/pages/pricing.tsx", "kind": "file" }
  ]
}
```

---

### `GET /search?q=<query>`

Semantic or keyword search across all file descriptions, names, and tags.

```
GET /search?q=authentication middleware
GET /search?q=database connection&limit=5
GET /search?q=stripe&team=backend
```

```json
{
  "query": "authentication middleware",
  "results": [
    {
      "id": "src/middleware/auth.ts",
      "score": 0.94,
      "description": "JWT validation middleware for protected routes",
      "tags": ["auth", "middleware", "jwt"]
    }
  ]
}
```

---

### `GET /node/<id>`

Full details for a single node including its dependencies.

```
GET /node/src%2Fpayments%2Fstripe.ts
```

Returns the node object plus its `dependsOn` and `usedBy` arrays.

---

### `GET /xref?file=<path>&fn=<functionName>`

Cross-reference a file and/or function. Returns all import connections and (if `codebase-memory-mcp` is installed) full call graph traces — every caller and callee.

```
GET /xref?file=src/payments/stripe.ts&fn=createCheckoutSession
```

```json
{
  "file": "src/payments/stripe.ts",
  "function": "createCheckoutSession",
  "importNeighbors": [...],
  "callNeighbors": [...],
  "functionCallers": [...],
  "functionCallees": [...],
  "impactSummary": "3 files connected via calls, 2 via imports"
}
```

---

### `GET /history`

Returns all recorded sessions with per-file change breakdowns.

```
GET /history
```

```json
{
  "activeTask": "add stripe checkout",
  "activeSession": {
    "task": "add stripe checkout",
    "startedAt": 1749000000000,
    "durationMs": 1800000,
    "filesInScope": 5
  },
  "sessions": [
    {
      "task": "fix auth timeout",
      "status": "complete",
      "durationMs": 2400000,
      "totalLinesAdded": 47,
      "totalLinesRemoved": 12,
      "filesChanged": ["src/auth/session.ts"],
      "changes": {
        "src/auth/session.ts": {
          "status": "modified",
          "linesBefore": 89,
          "linesAfter": 124,
          "delta": 35
        }
      }
    }
  ]
}
```

---

### `GET /task`

Current session status.

```
GET /task
```

```json
{
  "active": true,
  "task": "add stripe checkout",
  "startedAt": 1749000000000,
  "durationMs": 1200000,
  "filesInScope": 4
}
```

---

### `POST /task/start`

Start a session programmatically (agents can use this).

```
POST /task/start
Content-Type: application/json

{ "task": "add stripe checkout flow" }
```

---

### `POST /task/complete`

Complete the active session and compute the diff.

```
POST /task/complete
```

---

### `GET /entry-points`

Returns files identified as entry points (no incoming imports, top of the dependency tree). Useful for agents to understand the project's public interface.

```
GET /entry-points
```

---

### `GET /status`

Server health, version, and graph stats.

```
GET /status
```

```json
{
  "status": "ok",
  "version": "0.3.0",
  "stats": {
    "fileCount": 312,
    "nodeCount": 1203,
    "edgeCount": 847,
    "importEdges": 612
  }
}
```

---

### `GET /config` · `POST /config`

Read and modify the scan ignore patterns without editing config files.

```
GET /config
```

```json
{
  "defaultIgnore": ["node_modules/**", "dist/**", "*.test.ts"],
  "userIgnore": ["android/**"],
  "userUnignore": []
}
```

```
POST /config
Content-Type: application/json

{ "action": "add", "pattern": "android/**" }
{ "action": "remove", "pattern": "*.test.ts" }
{ "action": "restore", "pattern": "*.test.ts" }
{ "action": "reset", "pattern": "" }
```

After modifying, run `mycelium scan --clear` to rebuild with new filters.

---

### `GET /ui`

Opens the interactive graph viewer in your browser. The viewer auto-injects the correct server URL.

```
GET /ui
→ http://localhost:47821/ui
```

---

### `GET /debug`

Diagnostic information for troubleshooting. Shows sample node IDs, import edge counts, and alias resolution test results. Use when `/graph` shows nodes but no connections.

```
GET /debug
```

---

## Graph viewer

Open at `http://localhost:47821/ui` while the server is running.

**Nodes** — each dot is a file. Color = top-level directory. Size = line count × connection count.

**Edges** — solid lines are imports, dashed lines are function calls.

**Flow dots** — select a node and animated dots show dependency direction. Lime dots flow toward you (things you import). Pink dots flow away (things that import you).

### Navigation

| Action | Result |
|--------|--------|
| Click node | Select, center, animate connections |
| Double-click node | Ripple animation outward through neighbors |
| Double-click canvas | Fit entire graph to screen |
| Shift+click | Multi-select — shows common + union imports |
| Right-click node | Hide file, hide folder, pin node, isolate subtree |
| Scroll | Zoom |
| Drag canvas | Pan |
| ⊡ button | Fit to screen |
| ‹ pill on sidebar | Collapse/expand sidebar |
| `/` key | Focus search |
| `Esc` | Clear selection → clear subtree → clear search |

### Sidebar controls

**Imports** — toggle import edge visibility (instant, no rebuild)  
**Calls** — toggle call edge visibility  
**Functions** — show function/class symbols (Symbols zoom only)  
**Files / Symbols** — zoom between file-level and symbol-level view  
**Directory clusters** — overlay dashed folder grouping  
**⚙ Settings → Scan Filters** — manage ignore patterns  
**⚙ Settings → Appearance** — customize flow dot colors, colorblind presets  

### Task input (topbar)

Type a task description and press `→`. Mycelium highlights the most relevant files and shows match scores in the sidebar. This runs the same `/preflight` call your agent uses.

### History tab

Shows all completed sessions. Click any file in a session to jump to it in the graph. Sessions show duration, files touched, and line deltas in green/red.

Set or change the active task directly from the history tab using the **✎ change** button.

### Pinned nodes

Right-click → **Pin node** to lock a node's position in the simulation. Dragging a pinned node moves the pin to the new position. Pins survive page reloads.

### Isolate subtree

Right-click → **Show only subtree** to dim everything not reachable from that node (upstream and downstream). A banner appears with a **✕ Clear** button to dismiss.

### Copy as markdown

In the node detail panel, the **{ } MD** button copies the file's full info as a structured markdown block ready to paste into Claude or Cursor:

```markdown
## `src/payments/stripe.ts`
**file** · 231 lines

> Handles Stripe payment processing, webhook validation...

**Tags:** `payments`, `stripe`, `api`

**Imports (2):**
- `src/config/env.ts`
- `src/types/stripe.d.ts`

**Imported by (3):**
- `src/api/checkout.ts`
...
```

### Inline description editing

Click any file description in the sidebar to edit it. `Ctrl+Enter` saves. Updates the in-memory graph immediately and posts to `/describe` if that endpoint exists on your server.

---

## Agent configuration

`mycelium init` writes two files automatically:

**`CLAUDE.md`** — instructions for Claude Code on how to use Mycelium before starting any task.

**`.mcp.json`** — MCP server configuration so Claude Code discovers the endpoints automatically.

### Recommended agent workflow

```
1. Agent receives task from user
2. Agent calls GET /preflight?task=<description>
3. Agent reads only the returned files (4–8 instead of 40)
4. Agent makes changes
5. Agent calls POST /task/complete when done (optional)
```

### For Claude Code specifically

Add to your `CLAUDE.md` or system prompt:

```markdown
Before editing any file, call the Mycelium preflight endpoint:
GET http://localhost:47821/preflight?task=<your task description>

Read only the files returned. Do not read the entire codebase.
The contextSummary field in the response contains a pre-formatted
overview you can use directly.
```

---

## Session workflow

The session system records bounded units of work rather than individual file saves.

```bash
# Start — snapshot taken of all source files
mycelium task "refactor auth module"

# Your agent works here — files are saved, graph updates, nothing logged yet

# Done — diff computed against snapshot
mycelium task done

# Output shows exactly what changed:
#   ✓ Task complete  28m
#   2 files touched  +89 -34
#   Modified:
#     ~ src/auth/session.ts  120→174 lines  +54
#     ~ src/middleware/jwt.ts  45→10 lines  -35
```

Sessions are stored in `.mycelium/sessions.json` and visible in the graph viewer's History tab.

---

## Configuration

All configuration lives in `.mycelium/` inside your project.

| File | Contents |
|------|----------|
| `.mycelium/graph.json` | The dependency graph |
| `.mycelium/sessions.json` | Session history |
| `.mycelium/config.json` | Ignore patterns and user overrides |
| `.mycelium/embeddings.json` | Semantic embedding vectors |

Global API keys live in `~/.mycelium/config.json` (shared across all projects).

---

## How descriptions work

When you run `mycelium init`, Mycelium sends each source file to Claude Haiku with a prompt asking for a one-sentence description of what the file does, what it exports, and relevant tags. Descriptions are cached by file hash — if the file hasn't changed, the description is reused. This means re-running `init` is fast after the first run.

Descriptions power semantic search and preflight scoring. The better your descriptions, the more accurately Mycelium directs your agents. If a file has a weak description, you can click it in the graph viewer and edit it inline.

---

## Language support

Built-in parser covers TypeScript and JavaScript with full alias resolution.

If `codebase-memory-mcp` is installed, Mycelium uses it automatically for structural indexing across 150+ languages including Python, Go, Rust, Java, C++, and more, plus call graph tracing between functions.

---

## Troubleshooting

**No import edges in the graph**

Run `mycelium debug` to see sample node IDs and test alias resolution. The most common cause is import aliases (`@/`, `~/`, `#`) not matching the node IDs the graph uses. Check that your `tsconfig.json` paths are readable by the scanner.

**Descriptions are stale after a refactor**

Run `mycelium scan --clear` to clear and rebuild everything including descriptions.

**Server not found from agent**

Check that the server is running (`mycelium status` in another terminal) and that `.mcp.json` points to the correct port. Default is `47821`.

**`mycelium` not recognized in terminal**

Your global npm bin directory isn't in PATH.

```bash
npm config get prefix
# Add that directory to your PATH
```

---

## Roadmap

- [ ] `POST /describe` — persist inline description edits to disk  
- [ ] Git integration — branch overlay, changed files since last commit  
- [ ] Auto-refresh — live graph updates without page reload  
- [ ] Session replay — animate session history on the graph  
- [ ] Preflight accuracy metrics — track how well predictions matched actual edits  
- [ ] LOC/connectivity heatmap — color nodes by size or coupling instead of directory  
- [ ] Export PNG — snapshot current graph view  
- [ ] Mycelium Cloud — team sessions, shared history, web dashboard  

---

## Links

- **npm** — [@kopikocappu/mycelium](https://www.npmjs.com/package/@kopikocappu/mycelium)
- **GitHub** — [KopikoCappu/Mycelium](https://github.com/KopikoCappu/Mycelium)
- **Website** — [getmycelium.net](https://www.getmycelium.net)

---

<div align="center">
<sub>Built for developers who want their AI agents to actually understand their codebase.</sub>
</div>#   m y c e l i u m - p u b l i c 
 
 