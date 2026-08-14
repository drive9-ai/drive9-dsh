# Contributing

## Prerequisites

- Node.js 22.19 or newer
- npm

Install exactly from the lockfile:

```bash
npm ci
```

## Validation

Every behavioral change needs a direct regression test covering normal, edge, and
failure behavior. Run the same checks as CI:

```bash
npm run check
npm test
npm run test:race
npm run build
npm run lint:package
npm pack --dry-run
npm audit --omit=dev
```

Run `DRIVE9_REAL_E2E=1 npm run test:real` only on Linux with a real Drive9 FUSE mount
created using `drive9 mount --mode=fuse --profile=none` and dedicated test roots. The
test rejects WebDAV, ordinary local directories, and non-Linux hosts. See
[docs/operations.md](docs/operations.md).

Before publishing a release candidate, record the exact package and Drive9 CLI
commits, the non-skipped real-test pass count, and the reported propagation timings.

## Design constraints

- Keep filesystem, evidence storage, and result tools independently importable.
- Do not add a local-storage fallback when Drive9 startup validation fails.
- Preserve Drive9 revision CAS for guarded mutations.
- Preserve the mandatory startup probe and post-write mounted-byte wait for every
  write/edit path.
- Do not silently downgrade the strong filesystem contract to WebDAV or a local-overlay
  profile.
- Do not expose evidence paths, namespace listing, or possession-only authorization.
- Keep model-facing reads and searches bounded by package hard limits.
- Do not broaden V1 into a shell, sandbox, or LayerFS implementation.

Changes to these contracts require updating [docs/design-lock.md](docs/design-lock.md)
and obtaining a fresh design review before implementation.
