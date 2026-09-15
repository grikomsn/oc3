# oc3

OpenCode Console proxy for Codex and ChatGPT desktop.

oc3 runs a local Responses-API endpoint that routes Codex traffic to OpenCode Console
models (device-code OAuth, no API key) — the same pattern as `codex --oss` with Ollama,
but for Console. It also bridges models that only speak Chat Completions, and can expose
native OpenAI models when `OPENAI_API_KEY` is set.

## Install

```bash
bun install
bun link  # optional: exposes `oc3` on PATH
```

## Usage

```bash
oc3 login              # device-code sign in to OpenCode Console (opens browser)
oc3 models --refresh   # fetch org models, cache them, write ~/.config/oc3/codex-models.json
oc3 serve              # proxy on http://127.0.0.1:8788
oc3                    # TUI: model picker + server toggle (s), refresh (r), quit (q)
oc3 snippet            # print the Codex config.toml profile block
oc3 org [--org ID]     # list or select active Console organization
oc3 logout
```

## Wiring Codex manually

Paste the output of `oc3 snippet` into `~/.codex/config.toml`:

```toml
model = "acme/gpt-5.6-sol"
model_provider = "oc3"

[model_providers.oc3]
name = "OpenCode Console (oc3)"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"
```

Because it is a named provider, oc3 never collides with Ollama's top-level
`openai_base_url` override. Point the Codex desktop app at the same URL.

## How it routes

| Model endpoint (Console) | Behavior |
| --- | --- |
| `responses` (gpt-\*, grok-4, muse-spark) | Near-passthrough: injects OAuth bearer + `x-opencode-*` headers, forwards SSE |
| `chat-completions` (default) | Translates Responses requests to Chat Completions and re-emits Responses SSE events |
| `messages` / `google` | Not bridged yet (501) |

State lives in `OC3_HOME` (default `~/.config/oc3`):

- `session.json` — Console OAuth session (`0600`)
- `models.json` — cached org model catalog
- `codex-models.json` — Codex `model_catalog_json` file
- `state.json` — default model selected in the TUI

## Native OpenAI models

Set `OPENAI_API_KEY` to expose `openai/<model>` slugs (default:
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`; override with `OC3_OPENAI_MODELS`).
Requests route to `api.openai.com` using the Responses endpoint.

## Development

```bash
bun test          # unit + server integration tests
bun run typecheck # tsc --noEmit
```

## Scope notes

- Codex requests are stateless (`store: false`); oc3 holds no conversation state.
- Reasoning items and image inputs are not translated for Chat Completions models yet.
- The Anthropic (`messages`) and Google endpoints are not bridged yet.
