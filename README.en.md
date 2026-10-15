# ClarifyAI

[简体中文](README.md) | **English**

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)
![MCP](https://img.shields.io/badge/MCP-compatible-6f42c1.svg)

> **Make your AI clarify requirements before it writes a single line of code.**

ClarifyAI is a **requirement-clarification tool for AI coding assistants.**
It turns the assumptions an AI silently makes about your requirements into explicit,
individually-reviewable items on a visual mind map — so you settle the disagreement
*before* burning tokens and redoing the work.

---

## The Problem

When people describe requirements, they can usually only articulate the main three or four points.
The AI fills in the rest — and what it fills in is frequently not what you meant:

- It **never tells you which parts it guessed**
- When it guesses wrong, you find out in the code — or in a rewrite
- Several rounds later, tokens are gone and the requirements are still vague

ClarifyAI turns this into a **process with a definite end**:

```
Your one-sentence requirement
      │
      ▼
AI breaks it into 1/2/3 items ────► Rendered on the canvas
      │                                  │
Uncertain ones marked "AI assumption"  You edit / rule / add
      │                                  │
      └──────── AI receives your rulings ◄┘
                    │
                    ▼
     Drill into the next layer …… repeat
                    │
                    ▼
  Structured spec (JSON + Markdown) → fed back to the AI
```

---

## Core Design

### 1. "AI assumptions" are first-class citizens

Every inference the AI makes must be materialized as an item of kind `assumption`,
highlighted in amber on the canvas, **specifically awaiting your ruling**.

This is the single reason this tool exists: **keep the AI's guesses out of the implementation.**
Comparable tools hand you requirement items and never tell you which ones were invented — which
buries the problem deeper rather than solving it.

### 2. Acceptance criteria are mandatory, in WHEN/THEN form

Every requirement must carry an acceptance criterion of the form
`WHEN <precondition> THEN <observable outcome>`, and the format is soft-validated.

**If you cannot write the acceptance criterion, the requirement is not decomposed far enough —
or it is inherently vague.**

### 3. The round cursor — none of your actions are ever lost

MCP hosts time out tool calls (**measured: hosts cut off somewhere between 50 and 120 seconds**),
and restarting the server wipes in-memory state. ClarifyAI defends with a round cursor plus
on-disk data:

- `clarify_await` returns `pending` on timeout, and the next call **replays** everything that
  happened meanwhile
- After a server restart, a user's feedback is **recomputed from disk**, so a genuine submission
  never sinks without a trace

### 4. Edges are read-only

The requirement tree and its dependencies are drawn entirely by the system. Users **cannot drag
out any edge** (`allowNode` / `allowBlank` / `allowEdge` / `allowPort` are all disabled),
which rules out wrecking the structure by hand.

### 5. A visual canvas — without writing an editor plugin

The canvas is a horizontal mind map built with Vue 3 and AntV X6, using card-style nodes.
How it opens is up to the AI assistant — **the editor's built-in browser is enough**
(`workbench.action.openSimpleBrowser` in VS Code / Cursor, the built-in preview pane in JetBrains).
No native plugin is required.

---

## Quick Start

### Requirements

- Node.js **>= 20**

### Run from npm (recommended)

```bash
npx clarifyai --mode=http
```

Then open **http://127.0.0.1:4317**. The package is downloaded on first run and cached afterwards.

### Run from source

```bash
git clone https://github.com/lijiupeng/ClarifyAI.git
cd ClarifyAI
npm install
npm run build

# Single process: canvas + MCP over HTTP on the same port
node packages/server/dist/index.js --mode=http
```

Then open **http://127.0.0.1:4317**. The canvas is served by the backend itself —
no separate frontend dev server needed.

### Connect your AI assistant

**Option 1: MCP over HTTP (recommended)**

The service stays resident, so canvas availability does not depend on whether your assistant is
running, and both share the same session data.

```json
{
  "mcpServers": {
    "clarifyai": {
      "type": "http",
      "url": "http://127.0.0.1:4317/mcp"
    }
  }
}
```

**Option 2: stdio (the assistant spawns the process)**

```json
{
  "mcpServers": {
    "clarifyai": {
      "command": "node",
      "args": ["/absolute/path/to/ClarifyAI/packages/server/dist/index.js", "--mode=both"]
    }
  }
}
```

---

## How It Works

```
┌───────────────┐                        ┌──────────────────────┐
│ AI assistant  │◄─────── MCP ──────────►│                      │
│ (Claude Code, │    stdio / HTTP        │      ClarifyAI       │
│  Cursor ...)  │                        │   single process     │
└───────────────┘                        │                      │
                                         │  · session state     │
┌───────────────┐                        │  · feedback queue    │
│     You       │◄─── HTTP + WebSocket ─►│  · JSON persistence  │
│ (web canvas)  │                        │  · static hosting    │
└───────────────┘                        └──────────────────────┘
```

The server exposes **three** channels that all share one `SessionService` instance:

| Channel | Purpose |
|---|---|
| MCP stdio | Spawned by the assistant process |
| MCP over HTTP | Resident service, assistant connects by URL |
| HTTP + WebSocket | The browser canvas, kept in real time |

**Why it is built this way:** when the main agent submits a new decomposition over MCP, the canvas
must update immediately; when the user edits on the canvas, the server must wake the blocked agent.
Plain HTTP polling cannot do that.

---

## MCP Tools

Tools load in tiers so the descriptions themselves do not eat up the context window
(toggle with the `CLARIFY_TOOLS` environment variable).

| Tier | Tools | Description |
|---|---|---|
| `core` | 4 | Minimal loop |
| `standard` (default) | 6 | Full flow |
| `all` | 8 | Includes diagnostics |

| Tool | Purpose |
|---|---|
| `clarify_start` | Report project context + first-layer decomposition, open a session |
| `clarify_await` | Block until the user rules (**call in a loop until finalized**) |
| `clarify_submit_decomposition` | Submit the next layer / reply to annotations |
| `clarify_get_session` | Read current state without blocking |
| `clarify_finalize` | Close out and produce the requirement spec |
| `clarify_abort` | Terminate the session |
| `clarify_validate` | Requirement quality check (includes AI correction-rate stats) |
| `clarify_list_sessions` | Recover past sessions |

---

## Configuration

| Flag | Env var | Default | Description |
|---|---|---|---|
| `--mode` | `CLARIFY_MODE` | `both` | `mcp` / `http` / `both` |
| `--port` | `CLARIFY_PORT` | `4317` | HTTP port |
| `--host` | `CLARIFY_HOST` | `127.0.0.1` | Bind address |
| `--data-dir` | `CLARIFY_DATA_DIR` | `~/.clarifyai/sessions` | Session data directory |
| `--web-dist` | `CLARIFY_WEB_DIST` | auto-detected | Frontend build output |
| — | `CLARIFY_TOOLS` | `standard` | Tool tier |

> By default the server binds to loopback only and has **no authentication**.
> If you need `--host=0.0.0.0` to serve other machines, add access control first —
> do not expose a bare service to the network.

---

## Skill — teaching the assistant *when* to use it

MCP tools answer "how do I call it". **A skill answers "when should I think of calling it".**

Without a skill, an assistant will not spontaneously decide to clarify requirements before
starting work when you toss it a vague request.

This repo ships [`skills/clarify-requirements/SKILL.md`](skills/clarify-requirements/SKILL.md),
covering: when to trigger, opening the canvas in the editor's embedded browser, blocking polling,
service lifecycle, and common pitfalls (such as treating "draft" as "confirmed").

Wire it up according to your tool's skill-loading mechanism.

---

## Data

Sessions are persisted as **plain JSON** under `~/.clarifyai/sessions/<sessionId>.json`:

- No database dependency; no native compilation across platforms
- Transparent data you can open, diff, and commit to version control

Each file holds the full session state: raw requirement, project context, requirement tree,
baseline snapshot, and round cursor.

---

## Development

```bash
npm install
npm run dev                    # backend (4317) + frontend Vite (5173)

npm run smoke -w clarifyai    # end-to-end smoke test (24 assertions)
npm run typecheck                    # type checking
npm run build                        # build all artifacts
```

### Project layout

```
packages/
├── shared/     Single source of truth for the data contract
│               (zod schema → types → MCP tool I/O)
├── server/     Single process: session state machine + feedback queue + MCP + HTTP/WS
└── web/        Vue 3 + AntV X6 canvas
skills/         Skills for AI assistants
```

**Design rule**: `packages/shared` is the only source of truth for the contract. Server-side
validation, frontend types, and MCP tool `inputSchema` are all derived from it — never redefined.

---

## License

[MIT](LICENSE)
