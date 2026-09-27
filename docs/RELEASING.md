# Releasing

Agentar is published to npm as one package, [`agentar`](https://www.npmjs.com/package/agentar). It holds the CLI (with the bridge, MCP server and core bundled in) and the built web app. The workspace packages (`@agentar/*`) stay private.

`npm run release:build` assembles the package in `release/agentar/`. CI publishes it with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers): GitHub Actions proves its identity to npm with OIDC, so no npm token is stored in the repo or in GitHub secrets, and every release gets a provenance statement.

## One-time setup

npm only lets you add a trusted publisher to a package that already exists. So the first version is published by hand.

1. Log in to npm with an account that has 2FA turned on:

   ```bash
   npm login
   ```

2. Build and publish the first version from a clean checkout of `main`:

   ```bash
   npm ci
   npm run build
   npm run release:build
   npm publish ./release/agentar --access public
   ```

3. On npmjs.com, open the `agentar` package → **Settings** → **Trusted Publisher** → **GitHub Actions**, and enter:

   | Field | Value |
   | --- | --- |
   | Organization or user | `on-par` |
   | Repository | `agentar` |
   | Workflow filename | `publish.yml` |
   | Environment name | `npm` |

4. On the same settings page, under **Publishing access**, choose **Require two-factor authentication and disallow tokens**. Trusted publishing keeps working, and nobody can publish with a leaked token.

5. If you created an npm access token for step 2, delete it.

## Every release after that

1. Bump `version` in the root `package.json` and commit it to `main`.
2. Create a GitHub release with the tag `v<version>`, for example `v0.2.0`.
3. The **Publish to npm** workflow (`.github/workflows/publish.yml`) checks that the tag matches `package.json`, runs the build and tests, and publishes with provenance.

## Check a release locally

```bash
npm run build && npm run release:build
npm pack ./release/agentar     # inspect the tarball
```
