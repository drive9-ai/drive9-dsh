# Drive9 for DeepSeek Harness

Persistent agent workspaces and durable, bounded tool evidence for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

`@drive9/drive9-dsh` is a standard DSH bundle with independent Cordis components:

- a Drive9 revision-CAS filesystem for Harness `read`, `write`, and `edit` tools;
- an isolated evidence backend for oversized tool results;
- model-visible `result_search` and `result_read` tools with hard output limits;
- a model-visible runtime-context warning for the opt-in eventual mount profile;
- an optional foreground Bash provider backed by Drive9 Runtime exec.

The architecture keeps four lifecycles separate:

| Layer | Owner |
| --- | --- |
| Agent loop | DeepSeek Harness |
| Session and conversation history | DeepSeek Harness |
| Persistent workspace and immutable evidence | Drive9 |
| Shell | the user's DSH deployment by default; optional Drive9 Runtime exec |
| Local sandbox, terminals and language servers | the user's DSH deployment |

The Drive9 mount only exposes the persistent workspace inside an existing runtime.
It does not create, own, or keep that runtime alive. Evidence remains readable after
the runtime or workspace disappears because it is stored under a separate, unmounted
Drive9 root.

The default bundle retains DSH's local shell and sandbox. The optional
[Runtime shell](#optional-drive9-runtime-shell) runs foreground Bash remotely.
Storage exposes two explicit mount-consistency profiles:

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

## Prerequisites

- Linux with Node.js 22.19 or newer, npm, and pnpm on `PATH`;
- DeepSeek Harness `0.1.0-rc.6`, including the standard `dsh` CLI;
- a current Drive9 CLI with `drive9 token issue` support and access to a Drive9
  server;
- `/dev/fuse` and `fusermount3` for the recommended `strong` profile, or a WebDAV
  mount for the opt-in `eventual` profile;
- separate, path-scoped workspace and evidence credentials. An owner credential is
  needed only to create roots and issue those scoped credentials.

Install the Harness CLI and pnpm before continuing:

```bash
npm install --global @deepseek-ai/dsh@0.1.0-rc.6 pnpm
```

Install the Drive9 CLI from the
[public Drive9 repository](https://github.com/mem9-ai/drive9) and verify both CLIs:

```bash
dsh --version
drive9 version
```

## Quick start

Supply the owner credential through your normal secret injector, then configure the
non-secret paths once. The assertion fails before provisioning if the secret is
absent:

```bash
: "${DRIVE9_OWNER_API_KEY:?inject the Drive9 owner credential}"

export DRIVE9_BASE_URL="https://api.drive9.ai"
export DRIVE9_EVIDENCE_BASE_URL="$DRIVE9_BASE_URL"
export DRIVE9_MOUNT_ROOT="/mnt/drive9"
export DRIVE9_REMOTE_ROOT="/workspace"
export DRIVE9_EVIDENCE_ROOT="/evidence/dsh"
export DRIVE9_MOUNT_CONSISTENCY="strong"
```

### 1. Provision isolated roots and credentials

Create both roots once. Keep the evidence root unmounted so workspace tools and shell
commands cannot address it:

```bash
drive9 ctx add \
  --name dsh-owner \
  --server "$DRIVE9_BASE_URL" \
  --api-key "$DRIVE9_OWNER_API_KEY"
drive9 ctx use dsh-owner

drive9 fs mkdir :/workspace
drive9 fs mkdir :/evidence/dsh

drive9 token issue dsh-workspace \
  --ttl 24h \
  --allow /workspace:read,list,write,delete \
  --print

drive9 token issue dsh-evidence \
  --ttl 24h \
  --allow /evidence/dsh:read,write \
  --print
```

Each command prints only the bearer token and saves its local name for later rotation
or revocation. Store the printed value in your secret manager without leaving it on
disk, then inject the values as distinct credentials. The package rejects a shared
credential:

```bash
: "${DRIVE9_WORKSPACE_API_KEY:?inject the workspace-scoped credential}"
: "${DRIVE9_EVIDENCE_API_KEY:?inject the separate evidence-scoped credential}"
```

See [credential and deployment guidance](docs/operations.md) for production token
scope, TTL, and rotation guidance.

### 2. Mount the workspace

Mount the workspace into the Harness runtime. The default strong profile requires
Linux with `/dev/fuse` and `fusermount3`:

```bash
mkdir -p "$DRIVE9_MOUNT_ROOT"

DRIVE9_API_KEY="$DRIVE9_WORKSPACE_API_KEY" \
  drive9 mount --mode=fuse --profile=none :/workspace "$DRIVE9_MOUNT_ROOT"
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
  drive9 mount --mode=webdav --profile=none :/workspace "$DRIVE9_MOUNT_ROOT"

export DRIVE9_MOUNT_CONSISTENCY="eventual"
```

This profile returns from writes after the SDK CAS commits; it does not wait for the
mounted path to converge. Do not use it for workflows that write through Harness and
immediately validate with `cat`, `rg`, tests, a language server, or another subprocess.

### 3. Install the bundle

The recommended release channel is the prebuilt npm package:

```bash
dsh plugin --profile web add @drive9/drive9-dsh
```

To validate an unreleased checkout or install before registry publication, build the
same prebuilt tarball from the public repository instead of installing the TypeScript
sources directly from Git:

```bash
git clone https://github.com/drive9-ai/drive9-dsh.git
cd drive9-dsh
npm ci
PACKAGE_TARBALL="$(npm pack --silent)"
dsh plugin --profile web add "$PWD/$PACKAGE_TARBALL"
cd ..
```

This source-build route runs the package's normal `prepack` build and gives DSH a
tarball containing `dist/`. A direct `github:drive9-ai/drive9-dsh` dependency does not
contain built output and is not a supported install path.

The package declares a DSH bundle, so the standard `dsh plugin` command installs it
and adds its `cordis.patch.yml` layer to the selected profile. The bundle disables the stock
`fs-sandbox` and `spill-local` storage providers, then installs the Drive9 filesystem,
evidence backend, and result tools. Harness's stock filesystem tools, subprocess
runtime (unless Runtime exec is explicitly enabled), sandbox policy, observation policy, and spill policy remain in place. The
Drive9 filesystem implements the same per-call `read-only`, `workspace-write`, and
`danger-full-access` mutation policy that the replaced filesystem provider enforced.

### 4. Configure and run

```bash
cd "$DRIVE9_MOUNT_ROOT"
dsh web --dump-config
dsh web
```

`dsh web --dump-config` is the recommended preflight. Its composed tree must contain
exactly one active `fs` provider: `@drive9/drive9-dsh/filesystem`. Custom profiles
use the equivalent `dsh --profile <name> --dump-config` and `dsh --profile <name>`
commands; no Drive9-specific launcher is required.

To remove the bundle and its profile layer:

```bash
dsh plugin --profile web remove @drive9/drive9-dsh
```

In the default strong profile, startup fails instead of falling back or weakening the
contract when:

- the mount is missing or not writable;
- the remote root is missing or not a directory;
- SDK writes do not appear through the mount;
- mount writes do not produce a newer Drive9 revision through the SDK.

The eventual profile still validates the local mount directory and remote Drive9 root,
logs a prominent warning, adds the same warning to the model's durable runtime-context
snapshot, and skips the bidirectional proof by default. Explicitly setting
`verifyCoherence: true` still runs the complete proof and propagates any failure.

## Components

### `@drive9/drive9-dsh/filesystem`

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
| mutation policy | DSH per-call sandbox policy, rechecked against the fresh canonical target |

In `strong`, ordinary success returns only after the SDK write commits and the mounted
path exposes the same bytes. If Drive9 commits but the mount cannot be confirmed before
the bounded coherence deadline, the operation throws
`DRIVE9_WORKSPACE_COMMITTED_MOUNT_UNCONFIRMED` with `workspaceCommitted: true`, the
committed version, and reason `timeout`, `aborted`, or `io`. This is neither success nor
evidence that the write did not happen; callers must inspect/reconcile rather than
blindly retrying. In `eventual`, it returns after the SDK CAS succeeds; `processPath()` and
`fileUrl()` remain available, but their mounted view has no read-your-writes guarantee.
Both methods reject targets not authenticated by that filesystem instance.

### `@drive9/drive9-dsh/evidence`

`Drive9EvidenceStore` implements Harness `SpillStore`:

1. generate a random 256-bit capability;
2. create the content object;
3. create the canonical manifest with byte count and SHA-256;
4. publish `result_id` and a provenance receipt only after both writes succeed.

Reads verify stable revisions, exact byte count, manifest shape, SHA-256, and strict
UTF-8. A failed manifest write returns no locator. The unreachable content orphan can
be reclaimed by operator retention without exposing partial evidence to the model.

### `@drive9/drive9-dsh/result-tools`

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

Programmatic composition is also supported inside a DSH context that already provides
the standard `sandboxPolicy`, `systemPrompt`, and `tools` services:

```ts
import { Context } from '@deepseek-ai/cordis'
import * as Drive9Dsh from '@drive9/drive9-dsh'

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

`DRIVE9_WORKSPACE_COMMITTED_MOUNT_UNCONFIRMED` is the distinct post-commit outcome for
a strong-profile mount verification failure. It carries `workspaceCommitted: true` and
must never be treated as a retry-safe “write did not happen” error.

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

## Optional Drive9 Runtime shell

Set `DRIVE9_EXEC=true` to route the standard DSH `bash` tool through Drive9 exec.
The bundle disables the local Bash provider and background calls in this mode.
Unset the variable to keep the original local shell. Filesystem tools still use
SDK revision CAS and require the Drive9 mount; this is not a mount-free profile.

Runtime requires Linux, the `strong` mount profile, a server advertising streaming
exec and confirmed cancellation, and **separate workspace and evidence drives**.
At startup the integration checks their authenticated tenant identities. Two
different API keys for the same drive are insufficient: Runtime's `workspace.root`
sets its starting directory, not a fence against other directories on that drive.

Mount the workspace at the same absolute path that commands see remotely. For a
server advertising `/workspace` and a Drive9 subtree `/work`, configure:

```bash
export DRIVE9_EXEC=true
export DRIVE9_MOUNT_ROOT=/workspace/work
export DRIVE9_REMOTE_ROOT=/work
export DRIVE9_MOUNT_CONSISTENCY=strong
```

Create the strong-profile mount there using the mounting instructions above, with
the workspace credential. Keep `DRIVE9_WORKSPACE_API_KEY` and
`DRIVE9_EVIDENCE_API_KEY` in the Harness environment, with the latter belonging to
a separate drive. The provider uses the existing filesystem client for exec;
there is no additional Runtime credential or server setting.

**Permission must be explicit.** Runtime cannot enforce DSH's `read-only` or
`workspace-write` file policy across the entire remote filesystem. This provider
therefore rejects those modes. An operator choosing unrestricted remote execution
can explicitly select DSH's `danger-full-access` policy (for example with
`DSH_PERMISSION_MODE=danger-full-access` in the standard base profile). Enabling
`DRIVE9_EXEC` alone never changes that policy. Keep the default local shell if you
need DSH's confined modes. Remote commands do not receive the Harness host's
ambient environment or evidence credential.

Commands use `bash -c`, including Bash syntax such as arrays. Each call starts a
fresh shell; use `workdir` instead of relying on a previous `cd`. stdin injection,
background jobs and PTY are unsupported. Bash heredocs and pipes remain available.
Only the Bash capability is replaced: other process-backed Harness tools, such as
language servers and persistent terminals, continue to run in the Harness host.

The default timeout is 60 seconds and captured output is a 64 KiB tail per stream.
Timeouts and output budgets are capped by the server and package limits (15 minutes
and 1 MiB respectively). Truncation is explicit; no full-output file is invented.
A programmatic composition can load `@drive9/drive9-dsh/shell` with `timeoutMs` and
`maxOutputBytes`, or set `runtime: { timeoutMs: 60000, maxOutputBytes: 65536 }` on
the preset. It must remove the existing shell provider and configure the standard
bash tool with `enableRunInBackground: false`.

Ordinary command exit codes are preserved. Confirmed timeout and cancellation
report 124 and 130. Awaiting cancellation confirmation can add up to 20 seconds
after the command deadline. Executor failures remain errors, including `engine_error`,
which is distinct from grep's normal no-match exit 1. An unknown outcome includes
an execution ID when available and output tails. Inspect the result before
retrying: a broken connection is not proof that the command stopped. There is no
automatic local fallback or command retry.

The [Runtime contract](docs/runtime-exec.md) describes capability validation,
namespace checks and shutdown behavior. Automated tests cover the standard bash
tool in a real Harness loop, using the published SDK, a local HTTP fixture and
real Bash processes. They do **not** establish production Runtime/FUSE validation;
run the deployment's own live smoke checks before relying on this optional mode.

## Limits

V1 intentionally does not provide:

- a remote background shell, PTY, process sandbox provider, terminal, or language server;
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
| Drive9 JavaScript SDK | `0.3.0` |
| `strong` | Linux Drive9 FUSE; writes wait for exact process-visible bytes. Current real-service validation observed SDK-to-mount convergence in 1.3–1.5 seconds and mount-close-to-new-SDK-revision convergence in 0.36–0.40 seconds. These observations are not an SLA. |
| `eventual` | WebDAV; no subprocess read-your-writes guarantee, with observed staleness beyond 30 seconds. |

DeepSeek Harness is a developer preview. Upstream service-contract changes require a
new package release and contract review.
