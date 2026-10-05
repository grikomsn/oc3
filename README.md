# oc3

Run [OpenCode Console](https://opencode.ai/console) and Go models in OpenAI Codex and ChatGPT desktop — one local proxy, both OpenCode provider modes.

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
| `oc3` | TUI: Models · Account · Gateway · Proxy · Logs views |
| `oc3 start` | Apply overrides, start a detached proxy, boot ChatGPT desktop |
| `oc3 stop` | Restore your previous config and stop the proxy |
| `oc3 login` | Device-code sign in to OpenCode Console |
| `oc3 serve` | Proxy only, config untouched |
| `oc3 keys --set KEY [--mode console\|go]` | Store a service key (console by default, or `--mode go`; `--clear` wipes both) |
| `oc3 usage` | Show OpenCode Go subscription quota |

First run: `oc3 login` (opens the browser, picks the org), then `oc3 start`. Codex
and ChatGPT desktop are pointed at `http://127.0.0.1:8788` via the `[profiles.oc3]`
block — `oc3 start` writes it, `oc3 stop` removes it.

## Two modes, dual auth (no Console sign-in required)

Upstream merged the standalone Zen gateway into Console. oc3 now speaks upstream's
two modes, each with two auth methods — a stored service-account API key takes
precedence, the Console device-code session covers both modes in one sign-in:

| Mode | Provider id | Served by | Auth methods |
|---|---|---|---|
| **Console** (pay-as-you-go, formerly Zen) | `opencode/<model>` | `https://opencode.ai/zen/v1` (historical path) | device-code Console account **or** console service key |
| **Go** (subscription) | `opencode-go/<model>` | `https://opencode.ai/zen/go/v1` | device-code Console account **or** go service key |

```shell
oc3 keys --set <console-service-key>   # or --mode go <go-service-key>, or set OPENCODE_API_KEY
oc3 models --refresh                   # catalogs are public; Console sign-in upgrades the model list
oc3 start
```

| Command | What it does |
|---|---|
| TUI → Gateway (`3`) | Set/clear console and go service keys, check Go quota — no shell roundtrip |

Free models work without any credential. Signed in? The shared Console session also
authorizes go models — subscriptions are managed in the Console. Signed out without
keys? Anonymous requests hit the gateway's public sentinel and paid models stay hidden.

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
order: **OpenCode Console** (`opencode/<model>` and Console org models) →
**OpenCode Go** (`opencode-go/<model>`) → **ChatGPT (native)**
(`chatgpt/<model>`) → **OpenAI (native)** (`openai/<model>`). Display names
are prettified from raw ids ("gpt-5.6-sol" → "GPT 5.6 Sol") and carry a
bracketed backend tag — "GPT 5.6 Sol [Console]", "MiniMax M3 [Go]",
"Claude Sonnet 5 [Console]" — which also works as an alias: `modelKey` strips
it when routing, so `model [Console]` resolves to the same model. The native `chatgpt/*` slugs route to the
Codex ChatGPT backend with your own account session — disable them with
`OC3_CHATGPT_MODELS=""` or trim the list.

## Environment

| Variable | Purpose |
|---|---|
| `OC3_HOME` | State directory (default `~/.config/oc3`) |
| `OC3_WEBSEARCH_PROVIDER` | `exa` or `parallel` for hosted search |
| `OPENAI_API_KEY` | Expose native `openai/<model>` slugs |
| `OPENCODE_API_KEY` | OpenCode service key fallback for both modes (alternative to `oc3 keys`) |
| `OC3_CONSOLE_BASE_URL` | Console gateway base URL override (`OC3_ZEN_BASE_URL` legacy value still honored) |
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
