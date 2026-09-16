# Repository guide

## Project

oc3 is a minimal local proxy that lets OpenAI Codex (CLI, desktop, SDK) use
OpenCode Console models. It exposes an OpenAI Responses-API endpoint, translates
to whatever the Console model speaks, and manages config overrides for Codex.

- Bun + TypeScript. Node.js 24 is only needed for npm scripts.
- State lives in `~/.config/oc3` (`session.json` is `0600`, never commit it).
- The Codex config profile is written under `[profiles.oc3]` + `[model_providers.oc3]`;
  top-level `~/.codex/config.toml` values are only touched by the
  backup/restore in `start`/`stop`.

## Code map

- `src/cli.ts`: command dispatch, org picker, health waiting.
- `src/server.ts`: the proxy — routing, normalization pipeline, upstream calls, streaming.
- `src/translate.ts`: Responses ⇄ Chat Completions translation and the `EmittedEvent` contract (strict usage details, stop reasons, tool-call items).
- `src/desktop-normalize.ts`: ChatGPT-desktop request normalization (routing catalog thinking, auto-review alias, Full-Access exec, custom tool calls).
- `src/auth.ts`: device-code OAuth, single-flight refresh, org selection.
- `src/console.ts` / `src/models.ts`: Console model catalog and per-model endpoint kinds.
- `src/routing-catalog.ts` / `src/reasoning.ts`: thinking metadata and per-family effort wire formats.
- `src/repair.ts`: schema-aware tool-argument coercion and apply_patch envelope repair.
- `src/web-search.ts`: Exa/Parallel MCP bridging for the hosted `web_search` tool.
- `src/codex-config.ts` / `src/daemon.ts`: config.toml override/restore and detached-daemon lifecycle.
- `src/tui.ts`: OpenTUI dashboard.
- `src/protocol.ts` / `src/store.ts`: constants, header builders, and on-disk state.
- Tests are colocated in `test/` with mock upstreams; no live-network tests.

## Development

- Two-space indentation, double quotes, semicolons, explicit types at API boundaries.
- Keep the stateless contract: Codex sends `store: false` with full history; never hold conversation state.
- Never log or commit OAuth tokens, request bodies, or captured responses.
- Auth headers must match the injected-credential contract in `buildRequestHeaders`; do not impersonate the official Codex CLI.
- Treat Console and ChatGPT backends as undocumented integration surfaces; parse defensively and keep protocol-specific behavior covered by tests.
- Upstream streaming must preserve: SSE framing, tool-call item identity, reasoning deltas, truncated stop reasons, and usage details.
- Keep `npm/` (npm wrapper) and `npm-dist/` (CI-built platform packages) separate from the dev workspace; root `package.json` is private and never published.

## Commands

```bash
bun install
npm run check    # typecheck + lint + tests
npm run compile  # standalone binary to ./dist/oc3
```

Run the narrowest relevant test while iterating, then the full `check` before handing off.

## Before handing off

- Add a Changeset with `npm run changeset` for user-visible changes; docs, tests, and repo-maintenance-only changes do not need one.
- Never launch Codex, modify `~/.codex/config.toml`, or write outside `OC3_HOME` while testing — use temp `CODEX_HOME`/`OC3_HOME` and the `OC3_TEST_TOKEN` bypass for credential-dependent tests.
- Live verification of the real desktop app belongs to the user.
