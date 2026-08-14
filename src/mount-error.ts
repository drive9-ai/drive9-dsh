import { HarnessError } from '@deepseek-ai/dsh-llm'

export const DRIVE9_WORKSPACE_COMMITTED_MOUNT_UNCONFIRMED = 'DRIVE9_WORKSPACE_COMMITTED_MOUNT_UNCONFIRMED'

export type Drive9MountUnconfirmedReason = 'timeout' | 'aborted' | 'io'

export class Drive9WorkspaceCommittedMountUnconfirmedError extends HarnessError {
  readonly workspaceCommitted = true

  constructor(
    readonly committedVersion: string,
    readonly reason: Drive9MountUnconfirmedReason,
    options?: ErrorOptions,
  ) {
    const detail = reason === 'aborted'
      ? 'the caller cancelled mount visibility verification'
      : reason === 'timeout'
        ? 'the mount did not converge before the coherence deadline'
        : 'mount visibility verification failed'
    super(
      `Drive9 workspace revision ${committedVersion} committed, but process-visible mount bytes were not confirmed because ${detail}; do not blindly retry the write`,
      DRIVE9_WORKSPACE_COMMITTED_MOUNT_UNCONFIRMED,
      options,
    )
  }
}
