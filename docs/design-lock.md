# Drive9 for DeepSeek Harness: V1 Design Lock

Status: implementation contract for the first public release.

Source baselines:

- DeepSeek Harness `47f943859bef60e4160492346772ded9b24f765a`
- `@deepseek-ai/dsh-*` npm packages `0.1.0-rc.6`
- Drive9 JavaScript SDK `0.1.4`

## Product Boundary

Drive9 supplies a persistent workspace and durable evidence. It does not supply a shell, process sandbox, language server, or compute runtime.

The workspace is mounted before DeepSeek Harness starts. The mount and every process-backed Harness capability run in the same host, container, or VM. A deployment that cannot meet this condition must not load the workspace plugin.

Evidence uses a separate Drive9 credential and an unmounted root. Workspace tools, `processPath()`, `fileUrl()`, shell commands, and workspace deletion cannot address evidence objects.

V1 does not provide LayerFS checkpoints, workspace rollback, or exactly-once external tool side effects.

## Package Shape

One npm package, `@drive9-ai/drive9-dsh`, exposes independent Cordis components:

- `@drive9-ai/drive9-dsh/filesystem` — `Drive9FileSystem`, registered as `ctx.fs`.
- `@drive9-ai/drive9-dsh/evidence` — `Drive9EvidenceStore`, registered as `ctx.spillStore`.
- `@drive9-ai/drive9-dsh/result-tools` — bounded `result_read` and `result_search` tools.
- `@drive9-ai/drive9-dsh` — a programmatic preset that installs all three components.
- `@drive9-ai/drive9-dsh/cordis.patch.yml` — a DSH bundle patch for one-command installation.

The single package keeps installation simple without merging unrelated responsibilities. Every component remains independently importable and testable.

## Workspace Contract

### Identity and paths

`Drive9FileSystem` receives:

- an absolute process-visible `mountRoot`;
- an absolute POSIX `remoteRoot` describing the same Drive9 subtree;
- a Drive9 SDK client with access to that subtree.

`resolve()` canonicalizes through the mounted filesystem, follows existing symlinks, preserves a missing suffix below the nearest existing ancestor, and rejects lexical, symlink, prefix, NUL, and platform-separator escapes. Targets use an opaque provider-owned key. Consumers cannot manufacture or parse it.

`processPath()` and `fileUrl()` accept only targets minted by this provider and always return locations below the canonical mount root. A Drive9 evidence locator is not a filesystem target; resolving or presenting it as a path fails closed.

### Data plane

Model-facing storage operations use the Drive9 SDK. The mount is used only for canonical path resolution, no-follow metadata, process-visible paths, and the startup coherence proof.

| Harness operation | V1 implementation |
| --- | --- |
| `stat` | Drive9 `stat`; SDK revision becomes opaque `FsVersion` |
| `readText` / `streamText` | Drive9 read APIs with strict UTF-8 and binary rejection |
| `readBytes` | metadata preflight plus bounded range read |
| `listDir` | Drive9 list plus bounded `batchStat`, stable name order |
| guarded create | atomic SDK write with `expectedRevision: 0` |
| guarded replace | atomic SDK write with the exact observed revision |
| unconditional write | read/stat/CAS retry loop |
| guarded edit | read, literal edit, atomic write at the exact observed revision |
| unconditional edit | read/edit/CAS retry loop |

An SDK revision check followed by a mount write is forbidden: it is a check-then-write race and is not a valid implementation of `replaceIfVersion`.

After an SDK write succeeds, the provider waits for the mounted path to expose the exact bytes before returning. It fails with `FS_IO_ERROR` rather than claiming a coherent execution world when the mount remains stale.

### Startup proof

The filesystem service does not become injectable until it has:

1. verified that `mountRoot` is a writable directory;
2. verified that `remoteRoot` is a Drive9 directory;
3. created a unique probe through the SDK and observed identical bytes through the mount;
4. replaced the probe through the mount and observed a newer revision and identical bytes through the SDK;
5. removed the probe and confirmed cleanup.

Failure aborts plugin startup. There is no automatic fallback to a host-local directory and no automatic downgrade to metadata-based local stale detection.

The explicit fallback is to use DeepSeek Harness's own `fs-local`/`fs-sandbox` provider against a Drive9 mount. That separate profile is not implemented or advertised as strong Drive9 revision-CAS by this package.

## Evidence Contract

### Storage and publication

Each `saveText()` call creates a random 256-bit capability id. Content is written first to a unique create-only object, then an immutable manifest is written to a second create-only object. The manifest contains the producer session, tool/call metadata, exact UTF-8 byte count, and SHA-256 digest.

The opaque locator is returned only after both objects are durable. Only the returned locator may subsequently enter the Harness session log. If content succeeds but manifest publication fails, `saveText()` rejects and returns no locator; the content is an unreachable internal orphan for operator GC. Reading that capability fails closed because a valid immutable manifest is the publication record. A crash can therefore leave an unreachable orphan, but it cannot publish partial evidence, put a usable locator in the session log, or claim that evidence was persisted. Reads verify stable object revisions, byte count, and digest before returning content.

The evidence client and root are separate from the workspace client and mount. The package never exposes an evidence path, list operation, `processPath()`, or `fileUrl()`.

### Authorization

`result_read` and `result_search` require a live agent and an exact locator argument; neither tool scans an evidence namespace or a session's artifacts. Authorization never follows from arbitrary text containing a locator. It requires a Drive9 integration-authored evidence receipt in a prior `tool/result` or `tool/code-dispatch` record in the agent's immutable session log, plus a matching immutable Drive9 manifest.

The receipt is a strictly parsed, versioned record emitted by `saveText()` through its retrieval hint. Its locator, producing session, tool name, call id, and manifest digest must match the immutable manifest and the enclosing Harness event. A copied string is not a grant: for a live record the manifest producer must equal the current session, and for an inherited record it must equal the session's declared direct `parentSession` and appear before the durable `seedLength` boundary. A caller that constructs a seed manually is trusted same-process composition code under the Harness session contract; model/tool output cannot mark current text as seeded history.

The authorization set is:

```text
current-session issued locators + explicitly seeded inherited locators
```

`manifest.sessionId` is a provenance input, never sufficient authorization by itself. A fork may read a parent's locator only when the integration receipt is present in the child's seeded event prefix and the manifest producer is that declared parent. A guessed locator, a parent locator absent from the seed, and a sibling locator are denied. There is no artifact enumeration API and a child never re-owns inherited evidence.

The current tool call's arguments and arbitrary user, assistant, or tool text do not grant access. In particular, echoing a well-formed sibling locator or copied receipt in a later tool result does not satisfy the producer/call/event provenance checks.

### Retrieval limits

`result_read` and `result_search` enforce configuration bounded by hard package maxima:

- at most 1,000 returned lines;
- at most 64 KiB returned UTF-8 text;
- at most 100 search matches;
- at most 64 MiB scanned per request;
- at most 64 KiB query text.

Malformed, nonexistent, corrupt, unissued, or unauthorized locators fail closed with a stable `DRIVE9_RESULT_*` error. They never return an empty success that could be confused with an empty artifact.

### Retention

V1 is append-only from the Harness integration's perspective. Session end, workspace deletion, and workspace rollback do not delete evidence. Operators apply Drive9 retention or administrative garbage collection to the dedicated evidence root. The package does not silently invent a retention window.

## Spill Policy

The bundle keeps DeepSeek Harness's stock spill policy and replaces only its storage backend. The policy is explicitly best-effort:

- successful storage publishes an opaque locator only after durability;
- failed storage publishes no locator and leaves the original tool result inline.

This preserves tool success and avoids broken references. Source-streaming, crash-recoverable tool capture is a later protocol because the current `SpillStore` receives a fully materialized string.

## Failure Mapping

- missing target → `FS_NOT_FOUND`;
- wrong target type → `FS_NOT_DIRECTORY` or `FS_NOT_REGULAR_FILE`;
- invalid UTF-8 or NUL-containing text → `FS_NOT_TEXT`;
- read bound exceeded → `FS_TOO_LARGE`;
- 401/403 → `FS_PERMISSION_DENIED`;
- atomic revision conflict → `FS_STALE_VERSION` or `FS_NOT_OBSERVED`, according to the requested intent;
- cancellation before publication → `FS_ABORTED`;
- unavailable backend, incoherent mount, invalid provider target, or exhausted internal CAS retry → `FS_IO_ERROR`.

Errors never include API keys or authorization headers.

## Acceptance Tests

The release must include discriminating tests for:

1. SDK create/replace CAS, stale replacement, create conflict, and unconditional edit retry.
2. SDK write to mount visibility and mount write to newer SDK revision.
3. mount absence, wrong root, read-only root, symlink escape, `..` escape, and forged target rejection.
4. strict text decoding, binary rejection, bounded reads, stable listing, abort, permission, and backend failure mapping.
5. evidence unique-create publication, digest verification, bounded read/search, and storage or manifest-publication failure without a readable locator or session-log publication.
6. shell deletion of the workspace while evidence remains readable.
7. same-session unissued locator denial, plain-text tool echo denial, unseeded parent denial, sibling denial, and seeded direct-parent locator success.
8. evidence locator rejection by filesystem resolution/path methods.
9. a real DeepSeek Harness agent loop in which the model uses the filesystem tool, a process-backed tool observes the same mounted bytes, an oversized result spills, and later model calls retrieve it with `result_search`/`result_read`.

Hosted CI must run type checking, unit tests, the fake-Drive9 integration suite, package build, and `npm pack --dry-run`. A separately documented opt-in test exercises a real Drive9 mount and service.

## Compatibility

V1 targets the DeepSeek Harness `0.1.0-rc.6` contracts and Node.js 22.19 or newer. DeepSeek Harness is a developer preview; incompatible upstream service changes require a new package release and a fresh contract review.
