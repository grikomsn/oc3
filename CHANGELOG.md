# Changelog

## 0.0.1

- Initial release: OpenCode Console proxy for OpenAI Codex and ChatGPT desktop.
- Responses-API passthrough for gpt/grok/muse Console models; Chat Completions, Anthropic Messages, and Gemini GenerateContent translation for everything else.
- Device-code OAuth with single-flight refresh, org switching, and profile-based Codex config (no config.toml clobbering).
- Codex desktop transport: 426 HTTP fallback for WebSocket attempts, zstd request bodies, auto-review alias resolution, Full-Access exec schema scrubbing, routing catalog with thinking metadata.
- Model edge cases: schema-aware tool-argument repair, apply_patch envelope normalization, local_shell pairing, empty-tool-output annotation, truncated stop reasons, strict usage details, family-specific reasoning wire formats.
- Hosted web_search bridged client-side via Exa/Parallel MCP.
- Native OpenAI fallback with client auth headers; OpenTUI dashboard; detached daemon with status/logs/restore.
