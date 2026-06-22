<!-- graphmem:start -->
## Mycelium — Codebase Memory

This project uses **Mycelium** for AI agent memory.
Graph: **15 files**, **59 edges**, AI descriptions on every node.

---

### MANDATORY: Do this before touching ANY file

**Step 1 — Preflight your task**
```bash
curl "http://localhost:47821/preflight?task=DESCRIBE_YOUR_TASK_IN_PLAIN_ENGLISH"
```
Read ONLY the files returned. Do not explore the codebase blindly. The graph knows what's relevant.

**Step 2 — Check agent history**
```bash
curl "http://localhost:47821/history"
```
See what previous agents changed. Never repeat work or undo someone else's progress.

**Step 3 — Before modifying a function, check its impact**
```bash
curl "http://localhost:47821/xref?file=src/auth/token.ts&fn=refreshToken"
```
This shows every caller of that function and what it calls. Know the blast radius before changing anything.

**Step 4 — Make your changes**
Only now open files and make edits.

**Step 5 — After finishing**
Write a one-sentence summary of what you changed as a comment or in your response.
The next agent will read it.

---

### Other useful queries

```bash
# Semantic search
curl "http://localhost:47821/search?q=stripe+webhook"

# What a file imports and what imports it
curl "http://localhost:47821/dependencies?file=src/payments/stripe.ts"

# Full graph
curl "http://localhost:47821/graph"
```

### Team lenses: 
  - `core`

### Rules (non-negotiable)
1. /preflight before any file read. No exceptions.
2. /history if continuing existing work.
3. /xref before modifying any function with callers.
4. Read only preflight results. Trust the graph.
5. Summarize what you did when finished.
<!-- graphmem:end -->