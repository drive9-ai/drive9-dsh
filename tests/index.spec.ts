import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import apply from '../src/index.js'

describe('Drive9 DSH preset', () => {
  it('requires separate explicit workspace and evidence credentials before mounting services', async () => {
    await expect(apply(new Context(), {
      filesystem: { apiKey: '' },
      evidence: { apiKey: 'evidence-key' },
    })).rejects.toThrow('filesystem apiKey is required')

    await expect(apply(new Context(), {
      filesystem: { apiKey: 'same-key' },
      evidence: { apiKey: 'same-key' },
    })).rejects.toThrow('workspace and evidence must use different scoped credentials')
  })
})
