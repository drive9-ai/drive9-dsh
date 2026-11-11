# Drive9 Runtime shell integration

Status: implementation contract for the owner's November 11 exec request.
This extends the original mount-based V1; it does not replace its filesystem or
immutable evidence contracts.

## Entry point and namespace

An optional `@drive9/drive9-dsh/shell` Cordis provider implements foreground
`ctx.shell.run`. It uses the **same client object** as `Drive9FileSystem`, never a
second execution credential. The existing bundle remains mount-based by default;
an explicit Runtime option selects this provider instead of `bash-sandbox`.
The standard DSH bash tool remains the consumer. Its background option is disabled
in the Runtime configuration, and direct `start()` calls reject before network I/O.
No PTY, persistent shell state, LayerFS, local fallback or automatic retry is added.

DSH filesystem targets and commands must name the same paths: Runtime requires
strong-profile Linux FUSE, with the canonical mount path equal to the server's
`workspace_path` plus `remoteRoot`. The provider checks Runtime capabilities and
this mapping before becoming available. Workdirs are re-resolved through the
filesystem and translated to root-relative Runtime cwd. Command text is never
rewritten; the request uses `argv: ['bash', '-c', command]`, not the SDK's `/bin/sh`
string shortcut. Existing mounted filesystem coherence checks remain in force.

## Access and evidence

`workspace.root` is a starting directory, **not** an access boundary: Runtime can
access sibling directories on the authenticated drive. Before enabling Runtime,
read authenticated `status().tenant_id` for both the existing workspace and
Drive9 evidence clients. Both identities must be nonempty and different. Missing
identity, same tenant (even with distinct token strings), or failed status lookup
prevents startup. Use separate drives; never place evidence elsewhere on the
execution drive and assume an unmounted root protects it.

The current Runtime API can make its Drive9 mount read-only, but does not enforce
DSH's file-effect policy on the rest of the remote filesystem or an arbitrary
workspace subtree. Therefore this provider only accepts an explicitly resolved
`danger-full-access` policy. It rejects `read-only` and `workspace-write` before
exec rather than silently widening them. The bundle does not change the user's
sandbox policy. Users retaining confined DSH modes can continue using the existing
local sandbox executor over their Drive9 mount. Runtime does not expose the
Harness host, its environment or evidence credential to remote commands.

## Foreground contract

- Preserve ordinary exits, including 1, 2, 7 and 127, as completed command results.
- Validate/default/cap timeout and output limits before network I/O; send the
  bounded timeout to Runtime. Use the server-confirmed outcome to classify timeout
  or cancellation. Local signal cancellation alone is never proof of remote stop.
- Confirmed `RuntimeTimeoutError` / `RuntimeCanceledError` resolve with the
  corresponding mutually exclusive DSH flag. Do not invent an OS signal.
- Unknown outcomes, engine errors, unavailable/busy service and start failures
  reject with distinct `HarnessError` codes, retaining execution identity and
  bounded captured output for investigation. Never map engine error to grep's 1.
- Pre-aborted calls perform no exec. An aborted signal racing a normal terminal
  result does not overwrite that result inside the adapter.
- Runtime has no stdin input API: any supplied `stdin` rejects before exec.
  Model commands can use Bash heredocs/pipes. No shell interpolation of stdin.
- Forward only explicitly supplied env. Remove ordinary `DSH_*` keys, then merge
  the managed DSH snapshot. Never copy `process.env` or API credentials.
- Capture stdout and stderr separately with bounded byte tails and explicit
  truncation. Preserve split UTF-8 frames. No host temporary files or fabricated
  full-output spill path. Existing DSH evidence policy can persist the returned
  bounded result; it cannot recover already truncated bytes.
- Composition disposal cancels and drains in-flight calls; unknown remote stop
  remains an error. Background/PTY are unsupported, never represented by a fake
  completed or killed process handle.

## Limits, outcomes and shutdown

Startup has a 15-second deadline. Capabilities must advertise version >= 2,
`streaming: true`, `cancel: true`, a canonical absolute POSIX `workspace_path`,
and positive safe-integer `default_timeout_ms`, `max_timeout_ms`, and
`max_output_bytes`, with default timeout <= maximum. Missing or malformed fields
prevent startup, including a service that cannot confirm cancellation.

The default timeout is 60,000 ms, capped by the server maximum and a package
maximum of 900,000 ms. The default per-stream capture is 64 KiB, capped by the
server output maximum and a package maximum of 1 MiB. Per-call stdout budgets
may override that default within the same cap; stderr keeps the configured cap.
Overrides must be positive safe integers; zero, negatives, fractions, non-finite
values and invalid types are rejected. Oversized positive integers are clamped.

The same timeout also bounds client observation: its deadline requests cancellation
through the SDK. A confirmed cancellation caused by that deadline is a timeout;
failed confirmation remains an unknown outcome. Caller cancellation or shutdown
winning that race is classified as cancellation. Confirmation can take up to an
additional 20 seconds for the SDK cancellation request; the requested command
timeout is not a promise that the client has already returned.

Ordinary completion retains the remote exit code and sets both flags false.
Confirmed timeout returns exit code 124, `timedOut: true`, `aborted: false`;
confirmed cancellation returns 130, `aborted: true`, `timedOut: false`. Both have
`signal: null`: these are protocol outcomes, not observed OS signals. A signal
already aborted before dispatch throws `TOOL_ABORTED` without sending a command.
Other failures use `DRIVE9_EXEC_OUTCOME_UNKNOWN`, `DRIVE9_EXEC_ENGINE_ERROR`,
`DRIVE9_EXEC_BUSY`, `DRIVE9_EXEC_UNAVAILABLE`, `DRIVE9_EXEC_START_FAILED`, or
`DRIVE9_EXEC_FAILED`. Invalid inputs, policy, unsupported features and closed
providers use `DRIVE9_EXEC_INVALID_REQUEST`, `DRIVE9_EXEC_POLICY_DENIED`,
`DRIVE9_EXEC_UNSUPPORTED`, and `DRIVE9_EXEC_CLOSED` respectively. Failure messages
include execution identity and bounded stdout/stderr tails; unknown outcomes
explicitly prohibit assuming the command stopped or blindly repeating it.

Disposal first closes admission, then aborts all in-flight calls and waits at most
25 seconds (the SDK cancellation HTTP deadline is 20 seconds). An unknown outcome
or an unfinished call makes shutdown reject with `DRIVE9_EXEC_OUTCOME_UNKNOWN`;
it never reports successful cleanup. Every pending promise has a rejection
handler even if the shutdown deadline expires. There is no retry or second exec.

## Required validation

Use published `drive9@0.3.0` and DSH `0.1.0-rc.6`. Retain existing filesystem,
evidence and agent-loop tests. Add normal/edge/failure coverage for namespace and
tenant checks, policy rejection, actual Bash argv, cwd, managed env, stdin,
pre-abort, typed timeout/cancel/unknown/engine failures, nonzero exits, output
bounds/UTF-8 and direct background rejection. Compose the standard bash tool in
a real Harness agent loop against a local protocol fixture, checking file-write
and command-read/command-write and file-read on the same test namespace.
A fixture is not a production Runtime test. Document any unperformed live Linux
FUSE/Runtime validation; do not claim a release or remote deployment.
