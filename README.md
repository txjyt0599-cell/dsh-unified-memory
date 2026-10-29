# dsh-unified-memory

> A **local-first, self-forgetting, self-reinforcing** long-term memory plugin for [DSH](https://github.com/deepseek-ai).
> No cloud. No external vector DB. No lock-in. Your memory is a folder of JSONL files you own.

[English](README.md) | [简体中文](README.zh-CN.md)

---

## Table of contents

- [What it is](#what-it-is)
- [Why another memory system](#why-another-memory-system)
- [How it works](#how-it-works)
- [Install](#install)
- [Configuration](#configuration)
- [Tools it registers](#tools-it-registers)
- [Data layout](#data-layout)
- [Testing](#testing)
- [Security model](#security-model)
- [Known limitations](#known-limitations)
- [License](#license)

---

## What it is

A long-term memory layer for an AI assistant running on DSH. It turns conversations into durable **cards**, then decides *what to recall* on each turn using four competing forces rather than plain keyword search.

The core idea: **memory is not storage, it is selection.**
Storing everything is easy. The hard part is deciding what deserves to surface now, and what should quietly fade.

---

## Why another memory system

Most "AI memory" implementations are one of two things:

| Approach | Problem |
|---|---|
| Append to a context file | Grows without bound, eventually unusable |
| Vector store + top-k | Ignores importance and time; a throwaway remark from last year retrieves as strongly as a decision you made yesterday |

This plugin treats recall as a **ranking problem with decay**:

- A decision marked important stays reachable for months.
- A passing remark fades in weeks unless it keeps being used.
- Retrieval tracks *adoption* — a card that is fetched but never used does not gain weight.

---

## How it works

### Four layers

```
L0  raw conversation     conversations/*.jsonl    every turn, replayable
L1  fact cards           records/*.jsonl          extracted facts per window
L2  long-term memory     engrams.jsonl            durable cards + hypergraph
L3  persona & axioms     soul.md / host axioms    never decays
```

L0/L1 are *streams* — they age out. L2 holds the long-term line. L3 is permanent.

### The four forces

Every card is scored by four competing forces:

| Force | Meaning |
|---|---|
| **Relevance** | BM25 / vector / graph proximity to the current query |
| **Importance** | How much this matters long-term (corrections and decisions rank high) |
| **Recency** | Exponential decay with a per-card half-life |
| **Strength** | How often it has actually been used |

Half-life is derived from importance:

| Importance | Half-life |
|---|---|
| Axiom | never decays |
| >= 0.80 | 180 days |
| >= 0.55 | 60 days |
| otherwise | 21 days |

### Retrieval pipeline

```
query
  -> BM25 over the card pool        (always on, zero dependencies)
  -> + vector similarity            (optional, any OpenAI-compatible embedding endpoint)
  -> + hypergraph propagation       (optional, spreads along episode/entity edges)
  -> four-force rerank
  -> budgeted injection into the turn
```

Every stage after BM25 can be turned off independently. **If the vector service dies, retrieval degrades to BM25 — it never fails closed.**

### Dispatch receipt state machine

A non-obvious feature that grew out of real use: when you hand a task to another agent, you need to know *what actually happened to it*, not just that it was sent.

`dispatch_send` -> `dispatch_scan` -> `dispatch_close` tracks a task through eight states:

```
pending -> confirmed -> in_progress
                          |-> busy_ignored
                          |-> delivery_lost
                          |-> orphaned
                          |-> dead_target
                          |-> undetermined
                                      -> closed
```

The non-negotiable rule: **`inactive` is a healthy idle state, never "dead."** Conflating the two produces false alarms, which are worse than no alarm.

---

## Install

### Prerequisites

- **Node.js >= 20.18**
- **DSH >= 0.1.7-rc.1** — this is a DSH plugin, not a standalone daemon. It needs host services (`ctx.tools`, `ctx.sessions`, `ctx.sessionPersistence`, and optionally `ctx.agentTeams`).

### Steps

```bash
git clone <this-repo> dsh-unified-memory
cd dsh-unified-memory
npm install --omit=dev        # no runtime dependencies except the DSH peer
```

Add it to your DSH profile's plugin list, then restart DSH so the module is loaded.

Verify it loads cleanly:

```bash
node scripts/smoke-apply.mjs
```

That runs `apply(ctx, config)` against a fake context — the same path DSH uses on startup. If it passes, the plugin will not crash the host.

---

## Configuration

All configuration is optional. Defaults are chosen so the plugin does **nothing intrusive** until you turn features on.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PM_DATA_ROOT` | `~/.dsh/unified-memory` | Card stores, indexes, logs |
| `DSH_HOME` | `~/.dsh` | DSH home (data root is derived from it) |
| `PM_DIARY_ROOT` | `<data root>/diary` | Where diary files are written |
| `PM_SESSIONS_ROOT` | `~/.dsh/sessions` | DSH session storage (read for event sourcing) |
| `PM_DIARY_PROMPTS` | *(unset)* | Path to a JSON file overriding diary prompts |

### Models — the part that catches everyone

**Two separate model endpoints exist, and they control different things. If you skip this section, the plugin will appear to work but will never remember anything.**

| Config block | What it powers | If missing |
|---|---|---|
| `llm:` | **Card production** (extract / distill) | **No cards are ever created.** Search works, but the pool stays empty. |
| `embedding:` | Vector retrieval | Falls back to pure BM25. Still usable, weaker on paraphrase. |

Neither is fatal — the plugin degrades quietly rather than crashing. That is exactly why it is easy to misconfigure and not notice.

#### Where to put them

Add them under `config:` in your `cordis.patch.yml`:

```yaml
config:
  # ... the other keys ...

  # REQUIRED for memory to actually accumulate
  llm:
    enabled: true
    baseUrl: 'http://127.0.0.1:8080/v1'
    apiKey: 'not-needed-for-local'
    model: 'your-model-name'
    maxTokens: 4000
    temperature: 0.2
    timeoutMs: 60000

  # OPTIONAL — omit for BM25-only retrieval
  embedding:
    baseUrl: 'http://127.0.0.1:8080/v1'
    apiKey: 'not-needed-for-local'
    model: 'bge-m3'
    dimensions: 1024
```

Both are plain OpenAI-compatible endpoints, so any provider works — a local llama.cpp / Ollama server, or a hosted API.

`dimensions` must match your embedding model's real output size, or the vector index will be built wrong.

#### Alternative: inherit from your DSH profile

If your DSH profile already declares an `embedding:` block, leave the plugin's `embedding:` out and just point it at the profile:

```yaml
config:
  profilePath: '~/.dsh/profiles/web/cordis.patch.yml'
```

The key is read directly from that file — **it never passes through the agent context and is never written to logs.**

#### Quick check

After configuring, run the smoke test and look for the LLM line:

```bash
node scripts/smoke-apply.mjs
```

If `llm:` is unset, the plugin logs `ingest-llm-unavailable` and skips card production. Seeing that line means your key is not wired up.

### Diary prompts

The diary subsystem ships with **generic, role-agnostic prompts**. To use your own voice, point `PM_DIARY_PROMPTS` at a JSON file:

```json
{
  "master": "Write today's diary in first person...",
  "self": "Write a private note in first person..."
}
```

---

## Tools it registers

| Tool | What it does |
|---|---|
| `memory_search` | Search long-term memory |
| `memory_get` | Fetch one card in full |
| `memory_refute` | Mark a memory as wrong and record the correction |
| `diary_write` | Write a diary entry |
| `diary_read` | Read recent entries |
| `diary_config` | Inspect or change diary switches |
| `dispatch_send` | Dispatch a task and start tracking it |
| `dispatch_scan` | Reconcile tracked tasks against reality |
| `dispatch_close` | Close out a task with a verdict |
| `hotreload_probe` | Read-only self-inspection (loader / fiber / entry) |
| `hotreload_dryrun` | Report what a reload *would* do, without doing it |
| `hotreload_apply` | **Deliberately always refuses** — see below |

> **Why `hotreload_apply` refuses:** in-process self-reload was investigated and found to be **not safely achievable** without an external reloader. A disposed fiber leaves no live context to re-apply into, and the rescue path shares the same failure as the operation it guards. The refusal *is* the feature. Post-mortem is in `lib/dispatch/hotreload-exec.js`.

---

## Data layout

```
$PM_DATA_ROOT/
├── ingest/
│   ├── conversations/      L0 raw turns
│   ├── records/            L1 extracted facts
│   ├── engrams.jsonl       L2 durable cards
│   └── ongoing-thread.json hand-off snapshot between sessions
├── hypergraph/             episode / entity index shards
├── embeddings/             vector index
├── dispatch/               dispatch ledger (write-ahead, crash-recoverable)
├── logs/                   diagnostics (rotated, size-capped)
└── diary/                  diary state and index
```

**Everything is plain files.** Read them, back them up with `cp -r`, move them to another machine, or delete them and start over. There is no database to migrate.

---

## Testing

```bash
node scripts/smoke-apply.mjs          # startup smoke: apply() against a fake context
node selftest-dispatch-machine.mjs    # run one suite
```

**37 test suites** cover wiring, retrieval, rendering, cross-source merging, cache contracts, dispatch state transitions, diary behavior, and out-of-the-box defaults.

Design rule followed throughout: **every check has a negative test that actually fails when the invariant breaks.** A check that cannot fail is not a check.

---

## Security model

```bash
node scripts/security-audit.mjs    # secrets, personal paths, private content, credentials
node scripts/data-leak-audit.mjs   # real card IDs, session IDs, timestamps
```

**What this plugin does NOT do:**

- No telemetry. No phone-home.
- No credential storage. API keys are read from your DSH profile and never logged.
- No data leaves the machine except embedding calls to the endpoint *you* configure.

**What you must do:**

- Keep `$PM_DATA_ROOT` out of version control. The bundled `.gitignore` excludes it.
- Treat the data directory as private — it contains conversations in plain text.

---

## Defaults — what works out of the box

On first start the plugin writes a config template to `$PM_DATA_ROOT/ingest/config.json` and everything below is already on:

| Switch | Default | Notes |
|---|---|---|
| `enabled` / `capture` / `extract` / `distill` | **on** | Writing chain active from the start |
| `fourForcesEnabled` | **on** | Enable the multiplicative gate + three-tier half-life |
| `flashbackEnabled` | off | Optional side channel, off by default |
| `coldArchiveEnabled` / `coldArchiveAutoApply` | **off** | Moving cards is a physical, hard-to-undo action — deliberately not automatic |

Edit the generated file to change any of these; **changes take effect immediately, no restart needed.**

To turn the four-force gate back off (the old behaviour), set `fourForcesEnabled: false` — it is a one-field rollback, no code change required.

---

## Known limitations

Stated explicitly, because a memory system that overstates itself is worse than none:

| Limitation | Detail |
|---|---|
| **Depends on DSH** | Not a standalone service. Needs host services for sessions, tools, persistence. |
| **Hot reload impossible** | In-process self-reload leaves no live context. Requires a full DSH restart. |
| **Vector search optional** | Without an endpoint it is BM25 only — strong on exact terms, weaker on paraphrase. |
| **Card extraction needs an LLM** | `capture` and the hand-off snapshot work without one; `extract`/`distill` need an LLM channel. |
| **Hand-off is last-turn only** | `ongoing-thread.json` holds one snapshot, overwritten each turn. A continuity aid, not a transcript. |
| **Scene isolation is opt-in** | Off by default; unlabeled cards are always visible. |
| **Single writer assumed** | Two processes writing the same data root will conflict. |
| **No cross-machine sync** | Bring your own (this is a folder — rsync works fine). |

---

## License

**PolyForm Noncommercial 1.0.0** — free for personal, research, educational, and other noncommercial use. **Commercial use is not permitted** without a separate commercial license from the author.

See [LICENSE](LICENSE) for the full text.

> Note: because of the noncommercial restriction, this project is **source-available**, not OSI-approved open source.
