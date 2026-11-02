---
setup:
  - bun install --frozen-lockfile
---

A prifly extension built with bun: `bun install` brings in its dependencies (`d3-force`, `zod`,
the prifly extension API types and the dev tools). Tests run with `bun test`, and the
`typecheck` and `check` scripts in `package.json` run tsc and Biome.

The install relies on `bun` being on PATH and the npm registry being reachable. It also fetches
the extension API types (`@prifly/extension-api`) from github.com
(`github:jimmy927/prifly-extension-api`), so github.com must be reachable too. Nothing else is
needed outside the worktree: the tests use a fake `api` and make no network calls.
