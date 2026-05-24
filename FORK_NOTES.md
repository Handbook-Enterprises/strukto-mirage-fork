# Fork notes — Handbook-Enterprises/strukto-mirage-fork

This is a fork of [`strukto-ai/mirage`](https://github.com/strukto-ai/mirage)
maintained by Handbook Enterprises for use by `ve-brain` (and any other
downstream consumers).

## Why a fork

Several rough edges in mirage-core 0.0.1 surfaced while integrating into
ve-brain in May 2026:

- `ls FILE` returns ENOENT instead of echoing the file (mismatch with real
  ls behavior). Each per-backend `ls.ts` calls readdir without trying stat
  first when the path is a file.
- `find` outputs unqualified entry names (`Billing` instead of
  `/gmail/Billing`), breaking standard pipe patterns (`find ... | xargs ls`).
- `CalendarApiResource` exposes only top-level calendar names — no
  date-partitioning or per-event files, making the mount unnavigable from
  bash.

We're maintaining the fix here rather than waiting on upstream PRs because
ve-brain is in active rollout and the fixes are downstream-blocking.

## Layout

- `typescript/packages/core` is published as **`@viewengine/mirage-core`**
  (was `@struktoai/mirage-core`). Other packages (`agents`, `browser`,
  `node`, `server`) update their dep references but are not currently
  published from this fork.
- Versioning: `0.1.0-viewengine.N` (suffix bumps per-publish).
- Publish workflow: `.github/workflows/publish-core.yml` fires on
  `core-v*` tag push; tag must match `package.json` version.

## Upstream tracking

`upstream` remote points at `strukto-ai/mirage`. To pull upstream fixes:

```bash
git fetch upstream
git merge upstream/main   # resolve any conflicts, especially in package.json names
```

Bug-fix branches here should be prefixed `fix/` or `feat/` and named so
that upstream-worthy ones can be cherry-picked into PRs against
`strukto-ai/mirage` later.
