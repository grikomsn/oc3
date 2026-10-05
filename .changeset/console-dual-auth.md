---
"@nbrst/oc3": minor
---

Align the OpenCode auth setup with upstream's Console transition: two modes, dual auth.

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