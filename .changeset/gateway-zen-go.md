---
"@nbrst/oc3": minor
---

Cover the full OpenCode provider set: Zen and Go gateway variants alongside Console.

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
