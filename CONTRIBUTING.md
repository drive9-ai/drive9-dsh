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

## Public release

The package is published as a prebuilt public npm artifact. Do not publish TypeScript
sources or ask users to approve a Git dependency's build script.

Run the non-publishing release gate from a clean worktree:

```bash
npm run release:check
```

The release owner creates or owns the npm `drive9` organization, enables 2FA, and
logs in locally. Never send an npm password, OTP, or token through chat or commit it to
the repository. To run the same gate and publish the exact `package.json` version:

```bash
npm login
npm run release:publish
```

The script refuses a dirty worktree, an unexpected package name, a missing npm login,
and a version that already exists. It runs the complete validation suite, shows the
tarball contents, prompts for confirmation, and publishes with `--access public` to
the public npm registry.

After publication, verify the registry artifact rather than the local checkout:

```bash
npm view @drive9/drive9-dsh version
dsh plugin --profile web add @drive9/drive9-dsh
dsh web --dump-config
```

## Design constraints

- Keep filesystem, evidence storage, and result tools independently importable.
- Do not add a local-storage fallback when Drive9 startup validation fails.
- Preserve Drive9 revision CAS for guarded mutations.
- Preserve the mandatory startup proof and post-write mounted-byte wait for every
  strong-profile write/edit path.
- Keep WebDAV relaxation explicit as `mountConsistency: 'eventual'`, preserve its
  runtime warning, and never silently downgrade `strong` or suppress an explicitly
  requested proof.
- Preserve SDK revision CAS in both consistency profiles.
- Do not expose evidence paths, namespace listing, or possession-only authorization.
- Keep model-facing reads and searches bounded by package hard limits.
- Do not broaden V1 into a shell, sandbox, or LayerFS implementation.

Changes to these contracts require updating [docs/design-lock.md](docs/design-lock.md)
and obtaining a fresh design review before implementation.
