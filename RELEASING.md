# Releasing

Releases are managed by Changesets and `.github/workflows/release.yml`.

## npm setup (bootstrap complete)

`@nbrst/oc3` and the four per-platform binary packages (`@nbrst/oc3-darwin-arm64`,
`@nbrst/oc3-darwin-x64`, `@nbrst/oc3-linux-arm64`, `@nbrst/oc3-linux-x64`) are
published (0.1.0 bootstrapped locally with `npm publish --no-provenance`).

To switch CI publishing to provenance (long-term): configure each package's npm
trusted publisher with organization `nbrst`, repository `grikomsn/oc3`, workflow
`release.yml`, and allowed action `npm publish`. No long-lived `NPM_TOKEN` is
used by GitHub Actions; the release job receives `id-token: write` and publishes
with npm 11.5.1 or newer. Until that is configured, CI publishing or the local
flow (`npm publish --no-provenance`) still works without provenance.

Also required for the changesets version-PR step: repository settings →
Actions → General → "Allow GitHub Actions to create and approve pull requests".
Until then, version bumps are done locally with `bun run version` and committed
as `chore: version package`.

## Release flow

1. Add a changeset to each user-visible pull request with `npm run changeset`.
2. Changesets maintains a `chore: version package` pull request against `main`.
3. Merge that pull request.
4. The release workflow validates the package, cross-compiles the four platform binaries, publishes `@nbrst/oc3` and its per-platform packages with provenance, and creates the matching `v<version>` GitHub release with tarball assets and `checksums.txt`.

The first `@nbrst/oc3` publish must happen after the npm trusted publisher is configured; platform packages are created by the same workflow run. The `install` script and this site's homepage resolve versions from the GitHub release, so no further updates are needed after publishing.
