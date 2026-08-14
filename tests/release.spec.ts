import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('public release contract', () => {
  it('ships a valid guarded public-publish script', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      files: string[]
      license: string
      name: string
      publishConfig: { access: string }
      scripts: Record<string, string>
    }
    const scriptUrl = new URL('../scripts/release-public.sh', import.meta.url)
    const [script, license] = await Promise.all([
      readFile(scriptUrl, 'utf8'),
      readFile(new URL('../LICENSE', import.meta.url), 'utf8'),
    ])

    expect(packageJson.name).toBe('@drive9/drive9-dsh')
    expect(packageJson.license).toBe('Apache-2.0')
    expect(packageJson.publishConfig.access).toBe('public')
    expect(packageJson.files).toContain('LICENSE')
    expect(packageJson.files).toContain('scripts/release-public.sh')
    expect(packageJson.scripts['release:check']).toBe('bash scripts/release-public.sh --check')
    expect(packageJson.scripts['release:publish']).toBe('bash scripts/release-public.sh --publish')
    expect(license).toContain('Apache License\n                           Version 2.0, January 2004')
    expect(script).toContain('npm whoami --registry "$registry"')
    expect(script).toContain('npm org ls drive9 --json --registry "$registry"')
    expect(script).toContain('if [[ "$package_name" != "@drive9/drive9-dsh" ]]')
    expect(script).toContain('npm view "$package_ref" version --json --registry "$registry"')
    expect(script).toContain('if [[ "$view_output" != *"E404"* ]]')
    expect(script).toContain('npm publish --dry-run --access public --registry "$registry"')
    expect(script).toContain('npm publish --access public --registry "$registry"')

    const syntax = spawnSync('bash', ['-n', scriptUrl.pathname], { encoding: 'utf8' })
    expect(syntax).toMatchObject({ status: 0, stderr: '' })
  })

  it('uses the public npm scope in package-facing documentation', async () => {
    const [readme, ...documents] = await Promise.all(
      ['../README.md', '../CONTRIBUTING.md', '../docs/design-lock.md', '../docs/operations.md'].map(
        (path) => readFile(new URL(path, import.meta.url), 'utf8'),
      ),
    )

    const packageDocuments = [readme, ...documents].join('\n')
    expect(packageDocuments).not.toContain('@drive9-ai/drive9-dsh')
    expect(readme).toContain('drive9 token issue')
    expect(readme).toContain('--allow /workspace:read,list,write,delete')
    expect(readme).toContain('--print')
    expect(packageDocuments).not.toContain('--scope /workspace')
  })
})
