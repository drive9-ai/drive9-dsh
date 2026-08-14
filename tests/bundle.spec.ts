import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('DSH bundle patch', () => {
  it('replaces only the storage providers and keeps the shared policy services', async () => {
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

    expect(patch).toContain('- id: fs-sandbox\n  disabled: true')
    expect(patch).toContain('- id: spill-local\n  disabled: true')
    expect(patch.match(/name: '@drive9-ai\/drive9-dsh\/filesystem'/gu)).toHaveLength(1)
    expect(patch).toContain("name: '@drive9-ai/drive9-dsh/evidence'")
    expect(patch).toContain("name: '@drive9-ai/drive9-dsh/result-tools'")
    expect(patch).toContain("name: '@drive9-ai/drive9-dsh/runtime-context'")
    expect(patch).not.toContain('id: sandbox-policy')
    expect(patch).not.toContain('id: fs-observation-policy')
    expect(patch).not.toContain('id: spill-policy')
  })
})
