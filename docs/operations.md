# Deployment and operations

## Execution profiles

### Strong Linux FUSE

The default and recommended profile requires Linux with `/dev/fuse` and
`fusermount3`. Mount Drive9 before DeepSeek Harness starts:

```bash
mkdir -p /mnt/drive9
DRIVE9_API_KEY="$DRIVE9_WORKSPACE_API_KEY" \
  drive9 mount --mode=fuse --profile=none :/workspace /mnt/drive9
```

The Harness process, its subprocess provider, and every process-backed tool must see
that same mount path. `--profile=none` prevents a local coding-agent overlay from
splitting process paths from Drive9 SDK operations.

For a container deployment, prefer this order:

1. create or attach the container/VM;
2. mount the Drive9 workspace at `/mnt/drive9` inside that execution world;
3. export scoped workspace and evidence credentials;
4. start the selected DSH profile;
5. let `Drive9FileSystem` complete its bidirectional coherence probe.

Do not point a strong profile at an ordinary local directory, WebDAV mount, or
local-overlay profile. Startup deliberately tests SDK-to-mount and mount-to-SDK
visibility and fails rather than downgrading a split world.

Current real-service release validation observed SDK-to-mounted-byte convergence in
1.3–1.5 seconds and mount-close-to-new-SDK-revision convergence in 0.36–0.40 seconds.
These measurements are operational evidence, not an SLA; the strong profile still
fails closed at the configured coherence timeout.

### Eventual WebDAV

To accept relaxed subprocess visibility, mount with WebDAV and opt in explicitly:

```bash
mkdir -p /mnt/drive9
DRIVE9_API_KEY="$DRIVE9_WORKSPACE_API_KEY" \
  drive9 mount --mode=webdav --profile=none :/workspace /mnt/drive9

export DRIVE9_MOUNT_CONSISTENCY="eventual"
```

SDK-backed model reads, writes, revision CAS, and evidence remain authoritative. The
filesystem call returns when the SDK CAS commits and does not wait for WebDAV to
converge. The process-visible path may remain stale for more than 30 seconds. Do not
use this profile when an agent writes and immediately validates through `cat`, `rg`,
tests, a language server, or another subprocess. Startup logs this limitation.

## Credential separation

Use three credentials operationally:

| Credential | Used by | Minimum role |
| --- | --- | --- |
| owner/operator | provisioning only | create roots and issue/revoke scoped tokens |
| workspace | Drive9 mount and filesystem SDK | read/list/write/delete under workspace root |
| evidence | evidence SDK only | read/write under evidence root |

Example token issuance from an owner context:

```bash
drive9 token issue dsh-workspace \
  --ttl 24h \
  --allow /workspace:read,list,write,delete \
  --print

drive9 token issue dsh-evidence \
  --ttl 24h \
  --allow /evidence/dsh:read,write \
  --print
```

Use deployment secret injection for the returned tokens. Do not write them into
`cordis.patch.yml`, source control, shell history, or logs. Token TTL and rotation are
operator policy; restarting the mount and Harness profile after rotation is explicit.

The evidence token does not need workspace access. The workspace token must not have
evidence-root access. The package also rejects identical credential strings as a
configuration error.

## Evidence retention

The integration never deletes evidence on session end or workspace deletion. Apply
Drive9 retention or administrative garbage collection to `/evidence/dsh` according to
your audit policy.

Publication can leave one kind of internal orphan: content was created, but the
manifest creation failed. No locator was returned, so the artifact is unreachable to
agents. Operator GC may delete content objects that have no corresponding published
manifest after a suitable safety window.

Do not infer retention from workspace lifetime. Workspace state and execution evidence
have deliberately different deletion semantics.

## Health and startup

Treat failure to load the filesystem component as a deployment failure. Common causes:

- mount absent or not writable;
- an unsupported local-overlay or split mount profile;
- remote root absent;
- workspace credential missing required access;
- mount and SDK credentials refer to different tenants or roots;
- stale or disconnected mount;
- evidence root missing or evidence credential denied.

In `strong`, the coherence probe uses a unique hidden filename, deletes it on success,
and attempts best-effort cleanup after failure. Do not disable `verifyCoherence` in a
strong production deployment.

In `eventual`, the proof defaults off and the package emits a warning. Explicitly
setting `verifyCoherence: true` still runs it and does not suppress a failure. There is
no automatic profile switch in either direction.

## Real-service test

The opt-in test is excluded from the default suite. It requires a real Linux Drive9
FUSE subtree mounted with `--mode=fuse --profile=none` and a dedicated evidence-test
root. The test rejects non-Linux hosts and non-FUSE mount roots:

```bash
export DRIVE9_REAL_E2E=1
export DRIVE9_BASE_URL="https://api.drive9.ai"
export DRIVE9_WORKSPACE_API_KEY="..."
export DRIVE9_MOUNT_ROOT="/mnt/drive9"
export DRIVE9_REMOTE_ROOT="/workspace/dsh-e2e"
export DRIVE9_EVIDENCE_API_KEY="..."
export DRIVE9_EVIDENCE_ROOT="/evidence/dsh-e2e"

npm run test:real
```

The test:

1. verifies that the mount root is Linux FUSE;
2. runs the startup bidirectional coherence proof;
3. writes with Drive9 revision CAS and waits for exact mounted bytes;
4. reads identical bytes through the SDK, local file API, and `/bin/cat`;
5. overwrites and closes the mounted file, then waits for a newer SDK revision with
   exact bytes;
6. creates and verifies one evidence artifact;
7. deletes the temporary workspace file.

The evidence artifact remains for retention testing. Use a disposable evidence root or
operator cleanup policy for repeated runs.

For every release candidate, record the exact package commit, exact Drive9 CLI commit,
non-skipped real-test pass count, and SDK-to-mount plus mount-close-to-SDK timings. This
Linux FUSE test remains the release gate for the strong profile. WebDAV eventual
behavior is separately covered by a discriminator that proves SDK success does not
wait for mounted visibility and that the relaxed warning is present.
