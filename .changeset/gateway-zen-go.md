---
"@nbrst/oc3": minor
---

Cover the full OpenCode provider set: Zen and Go gateway variants alongside Console.

- New `oc3 keys` command (and `OPENCODE_API_KEY`) for Zen/Go API keys; free models work anonymously via the gateway's public sentinel.
- Public Zen (`opencode/<model>`) and Go (`opencode-go/<model>`) catalogs: live gateway `/models` merged with models.dev metadata, per-section cache that survives failed refreshes.
- Per-model credential routing: native OpenAI keys, gateway API keys, and Console OAuth sessions coexist in one proxy.
- Gateway wire parity: session-keyed prompt caching, encrypted-reasoning passthrough and auto summaries on Responses; Anthropic Messages and Gemini bridges reuse the gateway key; thinking-mode `chat_template_args`; trailing cost chunks are tolerated.
- `oc3 usage` shows OpenCode Go subscription quota; TUI shows gateway key status.
