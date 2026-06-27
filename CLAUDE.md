<!-- graphmem:start -->

# 🍄 Mycelium — Codebase Memory

This project uses **Mycelium** for AI agent memory and task tracking.
Graph: **19 files** · **61 edges** · AI descriptions on every node.

> **You are not the first agent here. Read before you touch anything.**

---

## Mandatory workflow — follow this every single time

### Step 0 — Start a session

```bash
mycelium task "describe exactly what you are about to do"
```

This takes a snapshot of the codebase so every file you touch gets recorded with a full diff. Skip this and your work goes untracked.

---

### Step 1 — Preflight your task

```bash
curl "http://localhost:47821/preflight?task=DESCRIBE_YOUR_TASK_IN_PLAIN_ENGLISH"
```

Returns the 4–8 files most relevant to your task. **Read only these files.** Do not explore the codebase blindly. The graph knows what's relevant — trust it.

---

### Step 2 — Check what previous agents did

```bash
curl "http://localhost:47821/history"
```

See every session that ran before you. What files were touched, how many lines changed, and an AI summary of what was done. Never repeat work or undo someone else's progress.

---

### Step 3 — Check blast radius before modifying any function

```bash
curl "http://localhost:47821/xref?file=src/auth/token.ts&fn=refreshToken"
```

Replace the file and function name with whatever you're about to change. This returns every caller and callee. If something imports or calls what you're modifying, read that file too before changing the signature.

---

### Step 4 — Make your changes

Only now open files and make edits. Stay within the files preflight returned unless xref revealed additional callers you need to update.

---

### Step 5 — End the session

```bash
mycelium task done
```

This computes the full diff — every file changed, lines added and removed, recorded in session history. The next agent will see exactly what you did.

---

## Other useful queries

```bash
# Semantic search across all file descriptions
curl "http://localhost:47821/search?q=stripe+webhook"

# What a file imports and what imports it
curl "http://localhost:47821/dependencies?file=src/payments/stripe.ts"

# Full dependency graph as JSON
curl "http://localhost:47821/graph"

# Single file details
curl "http://localhost:47821/node/src%2Fapi%2Forders.ts"

# Server health and graph stats
curl "http://localhost:47821/status"
```

---

## Rules — non-negotiable

| # | Rule |
|---|------|
| 1 | Run `mycelium task` before anything else |
| 2 | Run `/preflight` before reading any file |
| 3 | Run `/history` if continuing or building on existing work |
| 4 | Run `/xref` before modifying any function that has callers |
| 5 | Read only the files preflight returned — trust the graph |
| 6 | Run `mycelium task done` when finished |

## Team lenses
  - `core`

---

## Why this matters

Every agent that skips preflight reads 10× more files than necessary and burns through context that could be used for actual work. Every agent that skips `mycelium task done` leaves the next agent blind to what changed.

The graph viewer at **http://localhost:47821/ui** shows the full dependency map of this codebase. Open it if you want to understand the structure visually before starting.

<!-- graphmem:end -->