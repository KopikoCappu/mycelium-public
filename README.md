<div align="center">


# Mycelium

**Codebase memory for AI coding agents**

[![npm](https://img.shields.io/npm/v/@kopikocappu/mycelium)](https://www.npmjs.com/package/@kopikocappu/mycelium)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[getmycelium.net](https://www.getmycelium.net) · [npm](https://www.npmjs.com/package/@kopikocappu/mycelium) · [GitHub](https://github.com/KopikoCappu/Mycelium)

</div>

---

## The problem

AI coding agents read 30–40 files before touching anything. They have no memory of your codebase between sessions. Every task starts from zero.

## What Mycelium does

One command scans your project, builds a semantic dependency graph, and starts an MCP HTTP server. Your agent calls `/preflight?task=add stripe checkout` and gets back the 4–6 files it actually needs — ranked by relevance, with dependency context included.

Mycelium also tracks **work sessions**. Declare what you're building, let your agent run, then call `mycelium task done`. Mycelium computes exactly what changed, which files were touched, and generates an AI summary of the session.

---

## Install

```bash
npm install -g @kopikocappu/mycelium
```

```bash
mycelium key sk-ant-...        # Anthropic key (AI file descriptions)
mycelium key --openai sk-...   # OpenAI key (semantic search, recommended)
```

---

## Quick start

```bash
cd your-project
mycelium init                  # scan, describe, start server
# → graph viewer at http://localhost:47821/ui

mycelium task "add stripe checkout"
# use your agent normally
mycelium task done             # records what changed
```

---

## CLI

| Command | Description |
|---------|-------------|
| `mycelium init [path]` | Scan, describe all files, start server |
| `mycelium serve [path]` | Start server without rescanning |
| `mycelium scan [path]` | Rescan structure, skip AI descriptions |
| `mycelium task "description"` | Start a work session |
| `mycelium task done` | End session and compute diff |
| `mycelium task status` | Show active task and elapsed time |
| `mycelium task abandon` | Drop session without recording |
| `mycelium search <query>` | Search files by natural language |
| `mycelium status` | Graph stats and server state |
| `mycelium history` | Show completed sessions |
| `mycelium key` | Show or set API keys |
| `mycelium embed` | Generate/refresh semantic embeddings |
| `mycelium debug` | Diagnose missing import edges |

### `mycelium init` flags

```bash
mycelium init --port 4000      # custom port (default: 47821)
mycelium init --force          # clear and rebuild from scratch
mycelium init --no-serve       # scan only, don't start server
mycelium init --no-watch       # don't watch for file changes
```

### Session workflow

```bash
mycelium task "refactor auth module"
# → snapshot taken of all source files

# run your agent, make changes

mycelium task done
# ✓ Task complete  28m
# 2 files touched  +89 -34
#   ~ src/auth/session.ts    120→174 lines  +54
#   ~ src/middleware/jwt.ts   45→10 lines   -35
```

---

## MCP endpoints

The server runs at `http://localhost:47821` by default. `.mcp.json` is written automatically by `mycelium init` so Claude Code discovers it without any manual config.

### `GET /preflight?task=<description>`

The core endpoint. Returns the most relevant files for a task, ranked by semantic similarity.

```json
GET /preflight?task=add stripe checkout flow

{
  "task": "add stripe checkout flow",
  "mode": "semantic",
  "files": [
    { "nodeId": "src/payments/index.ts", "score": 0.91, "reason": "semantic" },
    { "nodeId": "src/api/checkout.ts",   "score": 0.87, "reason": "semantic" }
  ],
  "tokensSaved": 7200,
  "contextSummary": "## Mycelium Pre-flight: ..."
}
```

Agents should call this before touching any file. The `contextSummary` field is a pre-formatted markdown block ready to paste directly into context.

### Other endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /graph` | Full dependency graph (nodes + edges) |
| `GET /dependencies?file=` | What a file imports and who imports it |
| `GET /search?q=` | Semantic or keyword search across descriptions |
| `GET /node/<id>` | Single node with dependency details |
| `GET /xref?file=&fn=` | Import + call graph cross-reference |
| `GET /history` | All sessions with per-file change breakdowns |
| `GET /task` | Current session status |
| `POST /task/start` | Start a session programmatically |
| `POST /task/complete` | End session and compute diff |
| `GET /entry-points` | Files at the top of the dependency tree |
| `GET /status` | Server health and graph stats |
| `GET /config` | Read ignore patterns |
| `POST /config` | Add, remove, or reset ignore patterns |
| `GET /ui` | Graph viewer |
| `GET /debug` | Alias resolution diagnostics |

---

## Graph viewer

Open at `http://localhost:47821/ui` while the server is running.

- **Nodes** — each dot is a file. Color = directory. Size = lines × connections.
- **Edges** — solid lines are imports, dashed lines are function calls.
- **Flow dots** — select a node and animated dots show dependency direction. Lime flows toward you (imports). Pink flows away (imported by).

**Navigation**

| Action | Result |
|--------|--------|
| Click node | Select, center, show connections |
| Double-click node | Ripple animation through neighbors |
|
---

## How descriptions work

`mycelium init` sends each file to Claude Haiku for a one-sentence description, tags, and export summary. Descriptions are cached by file hash — unchanged files are never re-described. Re-running `init` is fast.

Descriptions power semantic search and preflight scoring. You can edit any description inline in the graph viewer if the generated one is weak.

---

## Language support

Built-in parser covers TypeScript and JavaScript with full `tsconfig.json` path alias resolution.

If `codebase-memory-mcp` is installed, Mycelium uses it automatically for structural indexing across 150+ languages — Python, Go, Rust, Java, C++, and more — plus full call graph tracing between functions.

---

## Troubleshooting

**No import edges in the graph**
Run `mycelium debug`. Most common cause: import aliases (`@/`, `~/`) not resolving to graph node IDs. Check that `tsconfig.json` is readable and paths are set correctly.

**Descriptions are stale after a refactor**
Run `mycelium scan --clear` to rebuild everything from scratch.

**Server not found from agent**
Run `mycelium status` in another terminal to confirm the server is up. Check that `.mcp.json` points to the right port (default `47821`).

**`mycelium` not found in terminal**
```bash
npm config get prefix
# add the output path to your PATH
```

---

## Roadmap

- [ ] Git integration — branch overlay, diff since last commit
- [ ] Session replay — animate history on the graph
- [ ] Auto-refresh — live graph updates without page reload
- [ ] Preflight accuracy metrics — track prediction vs actual edits
- [ ] LOC/connectivity heatmap
- [ ] Export PNG
- [ ] Mycelium Cloud — team sessions, shared history, web dashboard

---

## Configuration files

| Path | Contents |
|------|----------|
| `.mycelium/graph.json` | Dependency graph |
| `.mycelium/sessions.json` | Session history |
| `.mycelium/config.json` | Ignore patterns |
| `.mycelium/embeddings.json` | Semantic vectors |
| `~/.mycelium/config.json` | Global API keys (shared across projects) |

---

<div align="center">
<sub>Built for developers who want their AI agents to actually understand their codebase.</sub>
</div>
