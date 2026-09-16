# Security Policy

## Supported versions

Security fixes target the latest version published on [npm](https://www.npmjs.com/package/@nbrst/oc3). Update before reporting an issue that may already be fixed.

## Reporting a vulnerability

Email [security@nibras.co](mailto:security@nibras.co). Do not open a public issue or discussion.

Include, when applicable:

- Steps to reproduce or a proof of concept
- Affected versions and configuration
- Expected vs. actual behavior

## Scope

oc3 stores Console OAuth tokens under `~/.config/oc3/` with `0600` permissions and never sends them outside `opencode.ai` and the configured fallback backends. Reports about credential handling, header injection, or the proxy transport surface are in scope.
