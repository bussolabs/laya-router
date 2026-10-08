# laya-router

[![npm](https://img.shields.io/npm/v/@bussolabs/laya-router)](https://www.npmjs.com/package/@bussolabs/laya-router)

Automatic per-turn model routing for Claude Code and OpenAI Codex, decided by
[Laya](https://github.com/NandhaKishorM/laya), the open-source, Jev-compatible System One
decision model. Simple work goes to the fast tier, hard work to the strong tier, and each CLI
keeps its native interface, tools, sessions, permissions and authentication.

> **Credits.** This is a port of [gargpratyush/jev-router](https://github.com/gargpratyush/jev-router)
> (MIT). The proxy, the policy and the CLI integration are theirs. What changed: the routing
> decision comes from Laya instead of TypeSafe Jev, so it can run on your own machine with no
> API key, or on your own server.

| Command | Interface | Authentication | Routing decision |
| --- | --- | --- | --- |
| `laya-claude` | Claude Code | Existing `claude login` | Status line |
| `laya-codex` | OpenAI Codex | Existing `codex login` | Commentary line |

Both commands launch the real upstream CLI. Laya only chooses the model for a fresh user turn.

## Two ways to run Laya

| Mode | When | Set |
| --- | --- | --- |
| **Local** (default) | `LAYA_URL` is not set | nothing, or `LAYA_LOCAL_PORT` / `LAYA_MODEL_DIR` |
| **Server** | `LAYA_URL` is set | `LAYA_URL`, optionally `LAYA_API_KEY` and `LAYA_MODEL` |

**Local.** The router uses one shared [`laya-serve`](https://github.com/NandhaKishorM/laya/blob/main/docs/http-api.md)
on `http://127.0.0.1:8765`, running the **multilingual** checkpoint (100+ languages). If it is
not running, `laya-claude` / `laya-codex` start it in the background through
[uv](https://docs.astral.sh/uv/):

```bash
uv tool run --python 3.12 --from "laya[serve]==0.4.0" python serve/laya_serve.py
```

- **Needs uv.** Without it, local mode reports a clear error and turns keep the current model.
- **First start** downloads about 2 GB (Python packages with PyTorch ~1.4 GB, weights ~650 MB)
  and warms the model up before it reports ready; until then, turns keep the current model.
  Later starts take seconds.
- **Memory:** about 1.5 GB while the model is loaded. After 15 minutes without requests the
  model is unloaded; the next request loads it again.
- **The server keeps running** after the CLI exits, and is shared with every other
  laya-router or laya-compaction process. Stop it with `pkill -f laya_serve.py`.
- **Logs:** `~/.cache/laya-local/serve.log`.
- `LAYA_LOCAL_PORT` changes the port; `LAYA_MODEL_DIR` points at a fine-tuned checkpoint
  directory (see [`tuning/`](tuning/README.md)), which then replaces the built-in multilingual
  model.

**Server.** The router posts to `${LAYA_URL}/v1/systemone`, the Jev-compatible API of
laya-serve, on any machine you run. To serve the same setup (optionally with your fine-tuned
checkpoint) on a server:

```bash
LAYA_HOST=0.0.0.0 LAYA_PORT=8000 LAYA_API_KEY=change-me LAYA_CHECKPOINT=/path/to/checkpoint \
  uv tool run --python 3.12 --from "laya[serve]==0.4.0" python serve/laya_serve.py
```

```bash
# ~/.laya-router.env
LAYA_URL=https://laya.example.com
LAYA_API_KEY=change-me
```

`Authorization: Bearer <LAYA_API_KEY>` is sent only when the key is set. `LAYA_MODEL` names a
laya-serve checkpoint (`english`, `multilingual`, `typed-decisions`); leave it unset to let the
server pick per request.

## Quick start

Requires Node.js 20.12+, [uv](https://docs.astral.sh/uv/) for local mode, and at least one
supported CLI:
[Claude Code](https://code.claude.com/docs/en/setup) or
[OpenAI Codex](https://developers.openai.com/codex/cli).

```bash
npm install -g @bussolabs/laya-router
```

Package: [@bussolabs/laya-router on npm](https://www.npmjs.com/package/@bussolabs/laya-router).

Or from a local checkout:

```bash
git clone https://github.com/bussolabs/laya-router.git
cd laya-router
npm install
npm link
```

Then launch either interface from any repository:

```bash
laya-claude
laya-codex
```

No Anthropic or OpenAI API key is required when the corresponding CLI is already logged in
with a subscription. Every CLI argument is forwarded:

```bash
laya-claude --resume
laya-claude -p "fix the failing test"
laya-codex resume --last
laya-codex exec "fix the failing test"
```

Without `npm link`, run `node bin/laya-claude.mjs` or `node bin/laya-codex.mjs`.

## Claude Code interface

`laya-claude` launches Claude Code with **Laya Router** selected in `/model`. Selecting another
model pauses routing; selecting **Laya Router** resumes it.

The injected status line shows the model used for the last turn:

```text
⚡ haiku p=0.98 · my-project · 8% context
⏸ manual Opus 4.6 · my-project · 21% context
```

Claude Code otherwise remains unchanged, including its keybindings, tools, permission prompts,
`/compact`, `/resume`, and session handling. An existing custom `statusLine` is preserved;
set `LAYA_NO_STATUSLINE=1` to disable Laya's status line.

Run `/laya-explain` in `laya-claude`, or `$laya-explain` in `laya-codex`, to see the factors
behind the last routing decision (task complexity, reasoning required, tool complexity, context
size, recommended tier, confidence). The report is rendered locally from the exact request and
response saved when routing occurred; it does not ask Laya again.

Recent decisions (up to 20 per CLI session) are kept in one JSON file per session under
`<os temp dir>/laya-claude/`. They contain prompt text, so the directory is created with mode
700 and each file with 600; files untouched for 7 days are deleted.

> Choosing a model with `Enter` can save it as Claude Code's default. `laya-claude` restores
> the previous default on exit so `laya-router` cannot break plain `claude`.

## OpenAI Codex interface

`laya-codex` launches Codex with a temporary **Laya Router** provider and selects `laya-router`.
The native `/model` picker still lists the account's models; selecting one pauses routing.
Each fresh decision appears as Codex commentary:

```text
[Laya] routed this turn to gpt-5.6-sol (laya, confidence 0.91).
```

## How it works

Each command starts a loopback proxy, launches the real CLI, and forwards the CLI's own
authorization headers without reading, storing, or modifying them.

```text
you -> Claude Code -> laya-claude proxy -> Anthropic
                         |
                         +-> laya-serve (local or LAYA_URL): choose a tier
```

Laya receives the fresh prompt, the current model, an approximate context size and the
available models, and answers three `score` questions and one `choice` question in a single
forward pass. The architecture diagram is in
[`docs/laya-claude-architecture.md`](docs/laya-claude-architecture.md).

## Routing policy

| Tier | Claude Code default | Codex default |
| --- | --- | --- |
| Fast | Haiku | `gpt-5.6-luna` |
| Balanced | Sonnet | `gpt-5.6-terra` |
| Strong | Opus | `gpt-5.6-sol` |
| Long | Fable | `gpt-6-astra` |

`src/policy.mjs` then applies these rules:

- a turn that is exactly an explicit request such as `use opus`, `use luna`, or `use strong`
  wins; the phrase inside a longer prompt does nothing;
- failure, timeout, or an unrecognised Laya answer keeps the current model;
- low confidence never downgrades and caps upgrades at the balanced tier;
- large conversations refuse downgrades that would waste more prompt-cache work than they save;
- models whose context window cannot hold the request are not offered;
- unavailable tiers step upward rather than silently choosing a weaker model;
- the long tier is disabled unless `LAYA_ALLOW_FABLE=1`.

Confidence is the probability Laya gives the chosen model (laya-serve's `answer_confidence`). Laya's own `confidence` field measures entropy on a
different scale and is not used by the policy.

## Configuration

| Variable | Interface | Effect |
| --- | --- | --- |
| `LAYA_URL` | Both | Server mode: base URL of a laya-serve instance. Unset means local mode. |
| `LAYA_API_KEY` | Both | Server mode: bearer key, when the server requires one. |
| `LAYA_MODEL` | Both | Server mode: laya-serve checkpoint name; unset lets the server choose. |
| `LAYA_LOCAL_PORT` | Both | Local mode: port of the shared server (default `8765`). |
| `LAYA_MODEL_DIR` | Both | Local mode: fine-tuned checkpoint directory that replaces the multilingual model. |
| `LAYA_ALLOW_FABLE` | Both | Enables the opt-in long tier. |
| `LAYA_DEBUG` | Both | Logs decisions and rewrites to `~/.laya-claude.log` in interactive sessions. |
| `LAYA_DUMP` | Both | Dumps request bodies for debugging wire-format changes. |
| `LAYA_NO_STATUSLINE` | Claude | Disables the injected Claude status line. |
| `LAYA_CODEX_FAST_MODEL` | Codex | Fast model; defaults to `gpt-5.6-luna`. |
| `LAYA_CODEX_BALANCED_MODEL` | Codex | Balanced model; defaults to `gpt-5.6-terra`. |
| `LAYA_CODEX_STRONG_MODEL` | Codex | Strong model; defaults to `gpt-5.6-sol`. |
| `LAYA_CODEX_LONG_MODEL` | Codex | Long model; defaults to `gpt-6-astra`. |

Existing environment variables have highest precedence, followed by `.env` in the launch
directory and `~/.laya-router.env`. Never commit `LAYA_API_KEY`.

Tier definitions, Laya's questions, confidence thresholds, and timeouts live in
`src/config.mjs`.

## Fine-tuning Laya for routing

The base checkpoints were not trained on routing decisions. [`tuning/`](tuning/README.md) holds
the exact questions the router sends, synthetic examples in Laya's training format, a validator,
and step-by-step instructions to fine-tune and plug the checkpoint back in through
`LAYA_MODEL_DIR` or `LAYA_URL`.

## Development

```bash
npm install
npm test                  # mocked Laya; no server, no download
npm run tuning:validate   # checks tuning/*.jsonl
node test/live-routing.mjs
node bin/laya-claude.mjs -p "what is 2+2?"
```

## Limitations

- In server mode the prompt text is sent to your laya-serve instance. In local mode nothing
  leaves the machine except the one-time download of dependencies and weights.
- Laya adds latency only to the first request of a turn; tool-loop continuations add none.
- Claude Code and Codex request formats are not public contracts. Use `LAYA_DUMP` to diagnose
  upstream changes.
- Claude Code does not know the `laya-router` model name: in print mode it writes
  `[claude-code:unrecognized_model]` to stderr, and its usage and cost report is keyed by
  `laya-router`, so the cost it shows is an estimate. The real model is in the status line
  and in `/laya-explain`; billing follows the model that actually served the request.
- Run one router at a time: if `jev-router` is also installed, use either `jev-claude` or
  `laya-claude`, not both against the same session.
- Routing quality depends on the checkpoint: the base models are generic, so fine-tuning on
  your own routing decisions is recommended.

## License

MIT. Original work © 2026 Jev Router contributors; Laya port © 2026 Alessio Bussolari. The Laya
model weights are published by Convai Innovations under Apache 2.0.
