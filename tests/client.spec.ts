import { Drive9Error, StatusError } from 'drive9'
import { describe, expect, it } from 'vitest'
import { statusCodeOf } from '../src/client.js'

describe('statusCodeOf', () => {
  it('recognizes typed Drive9 status errors', () => {
    expect(statusCodeOf(new StatusError('forbidden', 403))).toBe(403)
  })

  it('recognizes the Drive9 SDK stat not-found error', () => {
    expect(statusCodeOf(new Drive9Error('not found: /workspace/missing.txt'))).toBe(404)
  })

  it('requires the exact Drive9 SDK not-found message prefix', () => {
    expect(statusCodeOf(new Drive9Error('not found /workspace/missing.txt'))).toBeUndefined()
  })

  it('does not infer status from unrelated errors', () => {
    expect(statusCodeOf(new Error('not found: /workspace/missing.txt'))).toBeUndefined()
  })
})
