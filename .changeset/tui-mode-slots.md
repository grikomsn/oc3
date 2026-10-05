---
"@nbrst/oc3": minor
---

Redesign the TUI and add per-mode account slots (separate Console and Go sign-ins).

- **TUI**: five ad-hoc views collapse into three — Models, Account, Runtime (proxy/overrides/requests + serve.log tail). One consistent keybinding scheme everywhere (`1-9`/arrow keys/`tab` switch views, `j/k`/`g/G` lists, `Enter` activate, `r` refresh, `/` filter with `up/down` moving the live list, `Esc` closes modals only, `q` quit), each view's hint bar is authoritative, and `?` lists the global scheme.
- **Account view**: one slot per mode. Console (org A) and Go (org B) hold independent device-code sessions, each with its own service key (`z` paste for the highlighted slot, `c` clear), org switching (`Enter`), sign in/out (`l`/`x`), and Go quota (`u`).
- **CLI**: `oc3 login --mode console|go` (default console), `oc3 logout [--mode M]` (default: every slot), `oc3 whoami` shows both slots, `oc3 org --mode M`.
- **State**: `sessions.json` stores per-mode slots; the legacy single `session.json` migrates into the console slot once and is cleared. Routing per mode: mode service key > that mode's session > anonymous "public" sentinel; with no go sign-in the console slot's session still authorizes go (upstream shared-session contract); org-config models stay on the console slot that discovered them; org headers always come from the acting slot.
- **Dedupe**: one catalog-entry mapper (`catalogModelSources`) behind the provider/gateway adapters, shared device sign-in orchestration (`src/signin.ts`), single slot-aware refresh flow, single sort source; deferred items (cross-repo shared auth library etc.) listed in the survey.