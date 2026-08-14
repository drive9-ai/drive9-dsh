# Deployment and operations

## Execution-world requirement

Mount Drive9 before DeepSeek Harness starts. The Harness process, its subprocess
provider, and every process-backed tool must see the same mount path.

For a container deployment, prefer this order:

1. create or attach the container/VM;
2. mount the Drive9 workspace at `/mnt/drive9` inside that execution world;
3. export scoped workspace and evidence credentials;
4. start the selected DSH profile;
5. let `Drive9FileSystem` complete its bidirectional coherence probe.

Do not point `DRIVE9_MOUNT_ROOT` at an ordinary local directory. Startup deliberately
tests SDK-to-mount and mount-to-SDK visibility and rejects split worlds.

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
- remote root absent;
- workspace credential missing required access;
- mount and SDK credentials refer to different tenants or roots;
- stale or disconnected mount;
- evidence root missing or evidence credential denied.

The coherence probe uses a unique hidden filename, deletes it on success, and attempts
best-effort cleanup after failure. Do not disable `verifyCoherence` in production unless
the deployment has an equivalent external proof and accepts the weaker startup gate.

## Real-service test

The opt-in test is excluded from the default suite. It requires a real mounted subtree
and a dedicated evidence-test root:

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

1. runs the startup coherence proof;
2. writes with Drive9 revision CAS;
3. reads identical bytes through the SDK, local file API, and `/bin/cat`;
4. creates and verifies one evidence artifact;
5. deletes the temporary workspace file.

The evidence artifact remains for retention testing. Use a disposable evidence root or
operator cleanup policy for repeated runs.
