# Releasing

Releases are managed by Changesets and `.github/workflows/release.yml`.

## One-time npm setup

If `@nbrst/oc3` does not exist on npm yet, an owner must bootstrap `0.0.1` once from a trusted local checkout with `npm publish --access public`. A trusted publisher is configured from an existing package's npm settings.

Then configure each package's npm trusted publisher with:

- Organization or user: `nbrst`
- Repository: `grikomsn/oc3`
- Workflow filename: `release.yml`
- Environment: leave blank
- Allowed action: `npm publish`

Packages: `@nbrst/oc3` plus the per-platform binaries `@nbrst/oc3-darwin-arm64`, `@nbrst/oc3-darwin-x64`, `@nbrst/oc3-linux-arm64`, and `@nbrst/oc3-linux-x64`.

No long-lived `NPM_TOKEN` is used by GitHub Actions. The release job runs on a GitHub-hosted runner, receives `id-token: write`, uses npm 11.5.1 or newer, and publishes with provenance.

## Release flow

1. Add a changeset to each user-visible pull request with `npm run changeset`.
2. Changesets maintains a `chore: version package` pull request against `main`.
3. Merge that pull request.
4. The release workflow validates the package, cross-compiles the four platform binaries, publishes `@nbrst/oc3` and its per-platform packages with provenance, and creates the matching `v<version>` GitHub release with tarball assets and `checksums.txt`.

The first `@nbrst/oc3` publish must happen after the npm trusted publisher is configured; platform packages are created by the same workflow run. The `install` script and this site's homepage resolve versions from the GitHub release, so no further updates are needed after publishing.
