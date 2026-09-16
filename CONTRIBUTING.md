# Contributing

Thanks for helping improve oc3.

## Before opening work

- Search existing issues before filing a bug or feature request.
- Report vulnerabilities according to [SECURITY.md](SECURITY.md), not in a public issue.
- Keep changes focused. Open an issue first when a proposal changes authentication, transport, or model routing.

## Development

Use Bun 1.2 or newer (Node.js 24 for npm scripts):

```sh
bun install
npm run check
npm run package
```

Add or update tests when behavior changes. Do not commit `.env` files, OAuth tokens, tarballs, or `node_modules/`.

User-visible changes need a Changeset:

```sh
npm run changeset
```

Documentation, tests, and repository-maintenance-only changes do not need one.

## Pull requests

A pull request should:

- Explain the problem and the chosen solution
- Stay limited to one coherent change
- Pass tests and typecheck (`npm run check`)
- Update documentation when auth, routing, or user workflows change
- Avoid unrelated dependency or formatting churn

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). For contribution questions, contact [griko@nibras.co](mailto:griko@nibras.co).
