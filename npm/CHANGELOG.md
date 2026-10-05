# @nbrst/oc3

## 0.1.0

### Minor Changes

- fc85e60: Align the OpenCode auth setup with upstream's Console transition: two modes, dual auth.
  
  Upstream merged the standalone Zen gateway into Console (provider id `opencode`, still
  served by the historical `/zen/v1` path) and added Go (`opencode-go`, `/zen/go/v1`) as the
  subscription mode. Both modes authorize with a Console device-code session or a per-mode
  service-account API key, with stored keys taking precedence over the device session.
  
  - `oc3 keys --set KEY [--mode console|go]` stores a per-mode service key (console by
    default); `oc3 keys` shows each slot; the TUI Gateway view edits console/go keys.
  - Legacy `keys.json` blobs with the shared gateway key under the `zen` slot migrate to the
    `console` slot on load and rewrite once; model display tags `[Zen]` become `[Console]`
    (group merge: Console → Go → ChatGPT → OpenAI).
  - The shared Console session now authorizes gateway models of BOTH modes when no key for
    that mode is stored; anonymous requests keep the free-only "public" sentinel and hide
    paid Console models; Go discovery stays public and unfiltered.
  - Public Console/Go discovery sends `Authorization: Bearer <service key | session token>`
    when one is available; org-scoped `/api/config` catalogs still require a device session
    with `x-org-id` and are never replaced by a public list.
  - `OC3_ZEN_BASE_URL` is deprecated in favor of `OC3_CONSOLE_BASE_URL` (legacy value still
    honored); docs and `oc3 keys`/`oc3 usage` hint text updated.
- 1e4188e: Cover the full OpenCode provider set: Zen and Go gateway variants alongside Console.
  
  - New `oc3 keys` command (and `OPENCODE_API_KEY`) for Zen/Go API keys; free models work anonymously via the gateway's public sentinel.
  - Public Zen (`opencode/<model>`) and Go (`opencode-go/<model>`) catalogs: live gateway `/models` merged with models.dev metadata, per-section cache that survives failed refreshes.
  - Per-model credential routing: native OpenAI keys, gateway API keys, and Console OAuth sessions coexist in one proxy.
  - Gateway wire parity: session-keyed prompt caching, encrypted-reasoning passthrough and auto summaries on Responses; Anthropic Messages and Gemini bridges reuse the gateway key; thinking-mode `chat_template_args`; trailing cost chunks are tolerated.
  - `oc3 usage` shows OpenCode Go subscription quota; TUI shows gateway key status.
  - Key UX: `oc3 keys --set <zen-api-key>` stores the shared gateway key (with `--clear` to wipe); interactive key editing lives in the TUI Gateway view.
  - Model metadata: display names prettified from raw ids, per-backend labels in the Codex picker descriptions, and stable group ordering (Console → Zen → Go → ChatGPT → OpenAI).
  - Native ChatGPT models are separated from the opencode variants: `chatgpt/<model>` slugs route to the ChatGPT backend with the client's own account session (`OC3_CHATGPT_MODELS` configures the list).
  - Backcompat cleanup: `oc3 snippet` and `oc3 catalog` commands removed (`start`/`models` cover them), legacy flat `models.json` no longer readable (run `oc3 models --refresh` once), and the user agent reports the real build version.
  - Coverage polish: per-model reasoning levels flow from the catalog into the Codex picker and routing file, both Console org headers are sent (`x-org-id` + `x-opencode-org-id`), backend-encrypted reasoning items are dropped on cross-provider model switches, gateway 429s point at `oc3 usage`, `x-opencode-project` is sent for gateway parity, and published per-token costs show in `oc3 models` and the TUI.
  - Display names carry a bracketed backend tag ([Console]/[Zen]/[Go]/[ChatGPT]/[OpenAI]) in the Codex picker, `oc3 models`, and the TUI so same-name models from different backends are distinguishable; the tag is stripped when routing.
- 2924e56: TUI overhaul: the dashboard is now five views instead of a single model list.
  
  - `1 Models`: grouped model list (Console, Zen, Go, ChatGPT, OpenAI) with
    per-model descriptions (endpoint, context, cost, reasoning efforts) and a
    type-to-filter input (`/`).
  - `2 Account`: device-code sign-in inline (`l`), org switching (Enter),
    sign-out (`x`) — no more "exit and run oc3 login".
  - `3 Gateway`: set/overwrite/clear Zen and Go keys inline (`z`/`g`/`c`) and
    check the Go subscription quota (`u`).
  - `4 Proxy`: server/daemon state (attaches to a running daemon instead of
    blind-starting a second server), config override + backup state, a live
    recent-request feed (time, status, duration, model), and ChatGPT desktop boot.
  - `5 Logs`: sticky-scrolling serve.log tail.
  - Global: `1`-`5`/`tab` switch views, `?` help overlay, contextual footers.
  - Gateway key editing reworked: one labeled input shows the current key
    masked (`sk-1a…9f`), `tab` switches between zen/go targets, Enter saves,
    Esc cancels, and the trigger key no longer leaks into the field.
  - Model filter is now fuzzy (subsequence matching with ranking: exact >
    prefix > word-start > scattered), and context lengths render compactly
    (400k / 1.2M).
  
  The proxy records the last 50 /responses requests in a ring buffer
  (`ServerHandle.recentRequests()`).
  
  Removed: the clack-based `oc3 keys` interactive menu (the TUI Gateway view
  replaces it); `oc3 keys` stays for `--set`/`--clear` and non-TTY status.
- fc85e60: Redesign the TUI and add per-mode account slots (separate Console and Go sign-ins).
  
  - **TUI**: five ad-hoc views collapse into three — Models, Account, Runtime (proxy/overrides/requests + serve.log tail). One consistent keybinding scheme everywhere (`1-9`/arrow keys/`tab` switch views, `j/k`/`g/G` lists, `Enter` activate, `r` refresh, `/` filter with `up/down` moving the live list, `Esc` closes modals only, `q` quit), each view's hint bar is authoritative, and `?` lists the global scheme.
  - **Account view**: one slot per mode. Console (org A) and Go (org B) hold independent device-code sessions, each with its own service key (`z` paste for the highlighted slot, `c` clear), org switching (`Enter`), sign in/out (`l`/`x`), and Go quota (`u`).
  - **CLI**: `oc3 login --mode console|go` (default console), `oc3 logout [--mode M]` (default: every slot), `oc3 whoami` shows both slots, `oc3 org --mode M`.
  - **State**: `sessions.json` stores per-mode slots; the legacy single `session.json` migrates into the console slot once and is cleared. Routing per mode: mode service key > that mode's session > anonymous "public" sentinel; with no go sign-in the console slot's session still authorizes go (upstream shared-session contract); org-config models stay on the console slot that discovered them; org headers always come from the acting slot.
  - **Dedupe**: one catalog-entry mapper (`catalogModelSources`) behind the provider/gateway adapters, shared device sign-in orchestration (`src/signin.ts`), single slot-aware refresh flow, single sort source; deferred items (cross-repo shared auth library etc.) listed in the survey.
- e0e7a14: The TUI now follows the terminal's color scheme: text and panel backgrounds use the terminal default foreground/background, and accents use ANSI palette slots (bright blue/green/yellow, muted bright black) instead of fixed hex colors.
