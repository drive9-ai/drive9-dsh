# Drive9 for DeepSeek Harness

Persistent agent workspaces and durable, bounded tool evidence for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

`@drive9-ai/drive9-dsh` is one install with three independent Cordis components:

- a Drive9 revision-CAS filesystem for Harness `read`, `write`, and `edit` tools;
- an isolated evidence backend for oversized tool results;
- model-visible `result_search` and `result_read` tools with hard output limits.

Drive9 does **not** provide a shell or sandbox. V1 exposes two explicit mount-consistency
profiles:

- `strong` (default and recommended) uses a Linux Drive9 FUSE mount in the same
  execution world as Harness process tools. Startup proves SDK-to-mount and
  mount-to-SDK coherence, and writes wait for exact mounted bytes before returning.
- `eventual` is an opt-in WebDAV profile. Model-facing reads, writes, revision CAS, and
  evidence still use the Drive9 SDK, but process tools may observe stale mounted bytes
  for more than 30 seconds after an SDK write.

The integration never silently downgrades `strong` to `eventual`. In real macOS
WebDAVFS validation, the Drive9 bridge observed an SDK write immediately while the
mounted `open`/`stat` view remained stale or blocked for more than 30 seconds.

## Why

Agent work has two different kinds of state:

```text
model filesystem tools ── Drive9 SDK + revision CAS ── persistent workspace
                                  │
process tools ── /mnt/drive9 ─────┘

large tool output ── isolated Drive9 evidence root ── exact result_id
                                                   ├─ result_search
                                                   └─ result_read
```

The workspace remains process-visible, while evidence stays outside the workspace
mount. A shell command, workspace deletion, or workspace rollback cannot address the
evidence namespace.

## Quick start

### 1. Mount the workspace

Configure Drive9, create the remote root once, and mount it into the Harness runtime.
The default strong profile requires Linux with `/dev/fuse` and `fusermount3`:

```bash
drive9 ctx add \
  --name dsh-owner \
  --server https://api.drive9.ai \
  --api-key "$DRIVE9_OWNER_API_KEY"

drive9 fs mkdir :/workspace
mkdir -p /mnt/drive9

DRIVE9_API_KEY="$DRIVE9_WORKSPACE_API_KEY" \
  drive9 mount --mode=fuse --profile=none :/workspace /mnt/drive9
```

The mount must exist in the **same execution world** as Harness subprocesses. If
Harness runs inside a container, mount Drive9 inside that container or bind the mount
into it before Harness starts.

`--profile=none` is part of the strong profile. A coding-agent mount profile can
route process paths through a local overlay while SDK calls still address Drive9,
splitting the two sides of the revision-CAS contract. Do not use a local-overlay
profile, and do not disable the startup proof to make one start.

To opt into relaxed WebDAV semantics instead, mount with WebDAV and explicitly select
`eventual`:

```bash
DRIVE9_API_KEY="$DRIVE9_WORKSPACE_API_KEY" \
  drive9 mount --mode=webdav --profile=none :/workspace /mnt/drive9

export DRIVE9_MOUNT_CONSISTENCY="eventual"
```

This profile returns from writes after the SDK CAS commits; it does not wait for the
mounted path to converge. Do not use it for workflows that write through Harness and
immediately validate with `cat`, `rg`, tests, a language server, or another subprocess.

### 2. Prepare isolated evidence storage

Create an unmounted evidence root and use a different, narrowly scoped credential for
it. Do not mount this root into the agent workspace.

```bash
drive9 fs mkdir :/evidence/dsh

export DRIVE9_WORKSPACE_API_KEY="...workspace-scoped token..."
export DRIVE9_EVIDENCE_API_KEY="...evidence-scoped token..."
```

See [credential and deployment guidance](docs/operations.md) for recommended Drive9
token scopes.

### 3. Install the bundle

```bash
dsh plugin --profile web add @drive9-ai/drive9-dsh
```

The package declares a DSH bundle, so `dsh plugin` installs it and adds its
`cordis.patch.yml` layer to the selected profile. The bundle disables the stock
`fs-sandbox` and `spill-local` providers, then installs the Drive9 filesystem,
evidence backend, and result tools. Harness's stock filesystem tools, subprocess
runtime, observation policy, and spill policy remain in place.

### 4. Configure and run

```bash
export DRIVE9_BASE_URL="https://api.drive9.ai"
export DRIVE9_MOUNT_ROOT="/mnt/drive9"
export DRIVE9_REMOTE_ROOT="/workspace"
export DRIVE9_EVIDENCE_ROOT="/evidence/dsh"

cd "$DRIVE9_MOUNT_ROOT"
dsh --profile web
```

In the default strong profile, startup fails instead of falling back or weakening the
contract when:

- the mount is missing or not writable;
- the remote root is missing or not a directory;
- SDK writes do not appear through the mount;
- mount writes do not produce a newer Drive9 revision through the SDK.

The eventual profile still validates the local mount directory and remote Drive9 root,
logs a prominent warning, and skips the bidirectional proof by default. Explicitly
setting `verifyCoherence: true` still runs the proof and propagates any failure.

## Components

### `@drive9-ai/drive9-dsh/filesystem`

`Drive9FileSystem` implements the complete Harness `FileSystem` contract.

| Operation | Drive9 behavior |
| --- | --- |
| `resolve` | Canonical mount resolution with lexical and symlink escape rejection |
| `processPath` / `fileUrl` | Authenticated provider targets mapped below the real mount |
| `stat` | Drive9 metadata; revision becomes an opaque Harness version |
| `readText` / `streamText` | Strict UTF-8, NUL rejection, no silent binary coercion |
| `readBytes` | Metadata preflight plus bounded range read |
| `listDir` | Stable sorting and `batchStat` requests capped at 256 paths |
| guarded write/edit | Exact Drive9 revision CAS |
| unconditional write/edit | Bounded read/modify/CAS retry |

In `strong`, a successful SDK write returns only after the mounted path exposes the
same bytes. In `eventual`, it returns after the SDK CAS succeeds; `processPath()` and
`fileUrl()` remain available, but their mounted view has no read-your-writes guarantee.
Both methods reject targets not authenticated by that filesystem instance.

### `@drive9-ai/drive9-dsh/evidence`

`Drive9EvidenceStore` implements Harness `SpillStore`:

1. generate a random 256-bit capability;
2. create the content object;
3. create the canonical manifest with byte count and SHA-256;
4. publish `result_id` and a provenance receipt only after both writes succeed.

Reads verify stable revisions, exact byte count, manifest shape, SHA-256, and strict
UTF-8. A failed manifest write returns no locator. The unreachable content orphan can
be reclaimed by operator retention without exposing partial evidence to the model.

### `@drive9-ai/drive9-dsh/result-tools`

The bundle registers:

```text
result_search(result_id, query, max_matches?, context_lines?)
result_read(result_id, offset?, limit?)
```

Both tools require an exact locator already issued into the current session's durable
tool history, or inherited from its explicitly seeded direct parent. Guessing,
enumeration, plain-text echoes, unseeded parent references, and sibling references are
denied.

Hard package limits:

- 1,000 returned lines;
- 64 KiB returned UTF-8 text;
- 100 search matches;
- 64 MiB scanned per request;
- 64 KiB search query.

## Configuration

The shipped bundle reads these environment variables:

| Variable | Required | Default | Purpose |
| --- | ---: | --- | --- |
| `DRIVE9_BASE_URL` | no | Drive9 SDK default | Drive9 API base for workspace SDK calls |
| `DRIVE9_WORKSPACE_API_KEY` | yes | — | Workspace-scoped SDK credential |
| `DRIVE9_MOUNT_ROOT` | no | `/mnt/drive9` | Process-visible Drive9 mount |
| `DRIVE9_REMOTE_ROOT` | no | `/` | Remote subtree represented by the mount |
| `DRIVE9_MOUNT_CONSISTENCY` | no | `strong` | `strong` Linux FUSE or explicit `eventual` WebDAV semantics |
| `DRIVE9_EVIDENCE_BASE_URL` | no | `DRIVE9_BASE_URL` | Drive9 API base for evidence |
| `DRIVE9_EVIDENCE_API_KEY` | yes | — | Separate evidence-scoped credential |
| `DRIVE9_EVIDENCE_ROOT` | no | `/evidence/dsh` | Unmounted evidence root |

Programmatic composition is also supported:

```ts
import { Context } from '@deepseek-ai/cordis'
import Drive9Dsh from '@drive9-ai/drive9-dsh'

const ctx = new Context()

await ctx.plugin(Drive9Dsh, {
  filesystem: {
    mountRoot: '/mnt/drive9',
    remoteRoot: '/workspace',
    baseUrl: process.env.DRIVE9_BASE_URL,
    apiKey: process.env.DRIVE9_WORKSPACE_API_KEY,
    mountConsistency: 'strong',
  },
  evidence: {
    root: '/evidence/dsh',
    baseUrl: process.env.DRIVE9_BASE_URL,
    apiKey: process.env.DRIVE9_EVIDENCE_API_KEY!,
  },
  resultTools: {
    maxScanBytes: 16 * 1024 * 1024,
  },
})
```

The preset rejects missing credentials and rejects using the same credential for
workspace and evidence.

## Errors

Filesystem failures use Harness `FS_*` codes, including `FS_STALE_VERSION`,
`FS_NOT_OBSERVED`, `FS_PERMISSION_DENIED`, `FS_TOO_LARGE`, `FS_NOT_TEXT`,
`FS_ABORTED`, and `FS_IO_ERROR`.

Evidence retrieval uses stable `DRIVE9_RESULT_*` codes:

- `DRIVE9_RESULT_INVALID_ID`
- `DRIVE9_RESULT_NOT_FOUND`
- `DRIVE9_RESULT_CORRUPT`
- `DRIVE9_RESULT_UNAUTHORIZED`
- `DRIVE9_RESULT_SCAN_LIMIT`
- `DRIVE9_RESULT_ABORTED`
- `DRIVE9_RESULT_IO`

Errors never include credentials or authorization headers.

## Security model

- Workspace and evidence credentials must be distinct and path-scoped.
- Evidence has no path, listing, mount, or filesystem-target API.
- Locators are random capabilities but are not authorized by possession alone.
- A versioned issuance receipt, immutable manifest, and enclosing Harness tool event
  must agree on session, tool name, call id, locator, and manifest digest.
- Current-session and explicitly seeded direct-parent evidence are readable; sibling
  and unseeded artifacts are not.
- V1 is append-only from the integration's perspective. Configure Drive9 retention or
  administrative GC for the evidence root.

See [SECURITY.md](SECURITY.md) and the complete [V1 design lock](docs/design-lock.md).

## Limits

V1 intentionally does not provide:

- a shell, process sandbox, terminal, or language server;
- automatic Drive9 mounting;
- strong subprocess read-your-writes through WebDAV;
- local-overlay support for either consistency profile;
- LayerFS checkpoints or workspace rollback;
- source-streaming or crash-recoverable tool capture;
- exactly-once external tool side effects;
- evidence enumeration.

The stock Harness spill policy receives a fully materialized tool result. Storage is
durable-before-reference, but tool output is not streamed to Drive9 at source in V1.

## Development

```bash
npm ci
npm run check
npm test
npm run test:race
npm run build
npm pack --dry-run
```

The default suite includes a scripted **real Harness agent loop**: the model uses the
stock filesystem tool, `/bin/cat` reads the same mounted bytes, an oversized result is
spilled, and later model steps invoke `result_search` and `result_read`.

For a real Drive9 service and Linux FUSE mount created with
`drive9 mount --mode=fuse --profile=none`:

```bash
DRIVE9_REAL_E2E=1 npm run test:real
```

Required environment and cleanup behavior are documented in
[docs/operations.md](docs/operations.md). See [CONTRIBUTING.md](CONTRIBUTING.md) for
the release checklist. The real test rejects non-Linux and non-FUSE mount roots.

## Compatibility

| Component or profile | Supported contract |
| --- | --- |
| Node.js | 22.19 or newer |
| DeepSeek Harness | `0.1.0-rc.6` |
| Drive9 JavaScript SDK | `0.1.4` |
| `strong` | Linux Drive9 FUSE; writes wait for exact process-visible bytes. Current real-service validation observed SDK-to-mount convergence in 1.3–1.5 seconds and mount-close-to-new-SDK-revision convergence in 0.36–0.40 seconds. These observations are not an SLA. |
| `eventual` | WebDAV; no subprocess read-your-writes guarantee, with observed staleness beyond 30 seconds. |

DeepSeek Harness is a developer preview. Upstream service-contract changes require a
new package release and contract review.
