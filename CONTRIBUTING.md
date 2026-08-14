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

Run `DRIVE9_REAL_E2E=1 npm run test:real` only with a real Drive9 mount and dedicated
test roots. See [docs/operations.md](docs/operations.md).

## Design constraints

- Keep filesystem, evidence storage, and result tools independently importable.
- Do not add a local-storage fallback when Drive9 startup validation fails.
- Preserve Drive9 revision CAS for guarded mutations.
- Do not expose evidence paths, namespace listing, or possession-only authorization.
- Keep model-facing reads and searches bounded by package hard limits.
- Do not broaden V1 into a shell, sandbox, or LayerFS implementation.

Changes to these contracts require updating [docs/design-lock.md](docs/design-lock.md)
and obtaining a fresh design review before implementation.
