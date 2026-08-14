import { HarnessError } from '@deepseek-ai/dsh-llm'

export type Drive9ResultErrorCode =
  | 'DRIVE9_RESULT_INVALID_ID'
  | 'DRIVE9_RESULT_NOT_FOUND'
  | 'DRIVE9_RESULT_CORRUPT'
  | 'DRIVE9_RESULT_UNAUTHORIZED'
  | 'DRIVE9_RESULT_SCAN_LIMIT'
  | 'DRIVE9_RESULT_ABORTED'
  | 'DRIVE9_RESULT_IO'

export class Drive9ResultError extends HarnessError {
  override readonly code: Drive9ResultErrorCode

  constructor(message: string, code: Drive9ResultErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}
