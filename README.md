# oc3

Run [OpenCode Console](https://opencode.ai/console), Zen, and Go models in OpenAI Codex and ChatGPT desktop — one local proxy, every OpenCode provider variant.

```shell
npx @nbrst/oc3
```

**That's it.** `oc3` signs in to Console with device-code OAuth, opens the model TUI, and points Codex at it via config-profile overrides. ChatGPT desktop, Codex CLI, and the Codex SDK all work through the same endpoint.

## Install

```shell
# npx (no install)
npx @nbrst/oc3
# or
bunx @nbrst/oc3

# install globally
npm install -g @nbrst/oc3

# or via the install script (prebuilt Bun binaries, no npm needed)
curl -fsSL https://oc3.nbr.st/install | bash
```

macOS (arm64/x64) and Linux (x64/arm64). Windows is not supported yet.

## Usage

| Command | What it does |
|---|---|
| `oc3` | TUI: pick a model, toggle server + config override, quit |
| `oc3 start` | Apply overrides, start a detached proxy, boot ChatGPT desktop |
| `oc3 stop` | Restore your previous config and stop the proxy |
| `oc3 login` | Device-code sign in to OpenCode Console |
| `oc3 serve` | Proxy only, config untouched |
| `oc3 keys` | Interactive key menu (opencode-style select + masked input) |
| `oc3 keys --set KEY` | Store your OpenCode Zen/Go API key (also `--zen`/`--go`, `--clear`) |
| `oc3 usage` | Show OpenCode Go subscription quota |

First run: `oc3 login` (opens the browser, picks the org), then `oc3 start`. Codex
and ChatGPT desktop are pointed at `http://127.0.0.1:8788` via the `[profiles.oc3]`
block — `oc3 start` writes it, `oc3 stop` removes it.

## Zen and Go (no Console sign-in needed)

The gateway variants work with a plain API key from [opencode.ai/auth](https://opencode.ai/auth):

```shell
oc3 keys --set <zen-api-key>   # or set OPENCODE_API_KEY
oc3 models --refresh           # Zen/Go catalogs are public; Console sign-in optional
oc3 start
```

| Command | What it does |
|---|---|
| `oc3 keys` (in the TUI: `a`) | Pick what to set, paste the key — masked, like `opencode auth login` |

Zen (`opencode/<model>`) is pay-as-you-go, Go (`opencode-go/<model>`) is the
subscription tier. Free/anonymous models work without any key. oc3 refreshes
both catalogs from the gateway's public `/models` endpoints, enriches them from
the models.dev snapshot, and translates Codex's Responses traffic into each
model's dialect (responses, chat-completions, Anthropic messages, Gemini) with
session-keyed prompt caching and encrypted-reasoning passthrough.

## How routing works

| Console model endpoint | What oc3 does |
|---|---|
| `responses` (gpt, grok, muse) | Near-passthrough: OAuth + `x-opencode-*` headers injected, SSE relayed verbatim |
| `chat-completions` | Full Responses ⇄ Chat Completions translation (tool calls, reasoning, truncated stops, strict usage) |
| `messages` / `google` | Anthropic Messages and Gemini GenerateContent bridges |
| `web_search` | Bridged client-side via Exa/Parallel MCP, mirroring OpenCode's own tool |
| not in catalog | Falls back to native OpenAI / ChatGPT backends with the client's own auth |

Extras baked in: schema-aware tool-argument repair, strict usage details,
thinking/effort normalization per model family, 426 fallback for desktop
WebSocket attempts, zstd request bodies, and a routing catalog with per-model
thinking metadata.

## Model picker groups

The Codex picker catalog is grouped and labeled by backend family, in this
order: **OpenCode Console** → **OpenCode Zen** (`opencode/<model>`) →
**OpenCode Go** (`opencode-go/<model>`) → **ChatGPT (native)**
(`chatgpt/<model>`) → **OpenAI (native)** (`openai/<model>`). Each entry's
description names its backend, and display names are prettified from raw ids
("gpt-5.6-sol" → "GPT 5.6 Sol"). The native `chatgpt/*` slugs route to the
Codex ChatGPT backend with your own account session — disable them with
`OC3_CHATGPT_MODELS=""` or trim the list.

## Environment

| Variable | Purpose |
|---|---|
| `OC3_HOME` | State directory (default `~/.config/oc3`) |
| `OC3_WEBSEARCH_PROVIDER` | `exa` or `parallel` for hosted search |
| `OPENAI_API_KEY` | Expose native `openai/<model>` slugs |
| `OPENCODE_API_KEY` | OpenCode Zen/Go gateway key (alternative to `oc3 keys`) |
| `OC3_CHATGPT_MODELS` | Comma-separated native `chatgpt/<model>` slugs (empty disables) |
| `PARALLEL_API_KEY` | Parallel search auth (optional) |

## Development

```shell
bun install
npm run check   # typecheck + tests
npm run changeset   # user-visible changes need a changeset
```

## Links

- [Homepage](https://oc3.nbr.st) · [Releases](https://github.com/grikomsn/oc3/releases) · [Releasing](RELEASING.md)
- Related: [opencodex](https://github.com/lidge-jun/opencodex) (heavier-weight), [ollama's codex proxy](https://github.com/ollama/ollama) (contract reference)

## License

[MIT](LICENSE) · Not affiliated with OpenAI or OpenCode
