---
"@nbrst/oc3": minor
---

Fix proxy, bridge, and CLI reliability issues found in an audit.

- **Proxy**: upstream retries are bounded, including 429 and `Retry-After`. Responses-path 500 "Router Unavailable" errors retry. A client disconnect cancels the upstream stream. Bridged Anthropic and Gemini requests get the same history normalization as chat. Web search returns failures as tool output and ends with an incomplete response at its round limit. Non-object request bodies return 400, and decompressed bodies are capped.
- **Streaming**: SSE events split across CRLF chunks parse correctly. Truncated `apply_patch` arguments no longer raise raw errors, and streamed `response.incomplete` events follow `finish_reason: "length"`.
- **Anthropic and Gemini**: thinking budgets stay below `max_tokens`, Claude 4.7+ uses adaptive thinking, forced tool choice falls back to `auto` while thinking is on, and `tool_choice: none` is kept. Signed Anthropic thinking and Gemini `thoughtSignature` are returned as reasoning items and replayed on the matching tool call, so tool loops keep their reasoning. Gemini thinking levels are limited to the values the models accept, `tool_choice: none` maps to `NONE`. Usage counts cache reads as input and thought tokens as output.
- **Config**: `~/.codex/config.toml` is parsed as TOML, including single-quoted values, escapes, and multi-line arrays. Backups keep each value's original text so restore is byte-exact. Writes are atomic and follow symlinks, and an unreadable backup is reported instead of ignored.
- **CLI and TUI**: `start` restores the config and stops the child if startup fails or is interrupted, and it only succeeds when the answering `/health` pid is the child it launched. `stop` only signals a verified `oc3 serve` process. `--mode`, `--port`, and `--lines` are validated. The org picker reads the typed choice. `oc3 keys` labels environment keys and shows only the last four characters of a key (short keys are fully hidden). The runtime view reads only the log tail, and an in-flight sign-in is cancelled on quit.
- **State**: `sessions.json`, `keys.json`, and `models.json` are written atomically with `0600` permissions. A corrupt file is moved aside instead of overwritten. Session shape and server URLs are validated, and a rotated refresh token is picked up after a failed refresh.
- **Catalog**: Console session tokens only reach Console catalog models on the session's own origin. Catalog headers cannot override credentials. Model refresh reports expired-session failures instead of crashing.
