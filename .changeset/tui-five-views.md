---
"oc3": minor
---

TUI overhaul: the dashboard is now five views instead of a single model list.

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

The proxy records the last 50 /responses requests in a ring buffer
(`ServerHandle.recentRequests()`).

Removed: the clack-based `oc3 keys` interactive menu (the TUI Gateway view
replaces it); `oc3 keys` stays for `--set`/`--clear` and non-TTY status.
