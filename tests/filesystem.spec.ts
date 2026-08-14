import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Drive9FileSystem } from '../src/filesystem.js'
import type { Drive9MountConsistency } from '../src/filesystem.js'
import { FakeDrive9Client, FakeStatusError } from './fake-drive9.js'

const roots: string[] = []

class HangingMountStatFileSystem extends Drive9FileSystem {
  protected override mountStat(_processPath: string): Promise<never> {
    return new Promise<never>(() => {})
  }
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function setup(overrides: {
  verifyCoherence?: boolean
  mirrored?: boolean
  mirrorWrites?: boolean
  mirrorDeletes?: boolean
  mountConsistency?: Drive9MountConsistency
  hangMountStat?: boolean
} = {}) {
  const mountRoot = await mkdtemp(join(tmpdir(), 'drive9-dsh-fs-'))
  roots.push(mountRoot)
  const client = new FakeDrive9Client(overrides.mirrored === false
    ? {}
    : {
        mountRoot,
        remoteRoot: '/workspace',
        ...(overrides.mirrorWrites === undefined ? {} : { mirrorWrites: overrides.mirrorWrites }),
        ...(overrides.mirrorDeletes === undefined ? {} : { mirrorDeletes: overrides.mirrorDeletes }),
      })
  client.mkdirRecord('/workspace')
  const context = new Context().intercept('logger', { level: 2 })
  const FileSystemClass = overrides.hangMountStat === true ? HangingMountStatFileSystem : Drive9FileSystem
  const fs = new FileSystemClass(context, {
    mountRoot,
    remoteRoot: '/workspace',
    apiKey: 'workspace-key',
    ...(overrides.mountConsistency === undefined ? {} : { mountConsistency: overrides.mountConsistency }),
    ...(overrides.verifyCoherence === undefined ? {} : { verifyCoherence: overrides.verifyCoherence }),
    coherenceTimeoutMs: 100,
    coherencePollMs: 2,
  }, () => client)
  return { fs, client, context, mountRoot }
}

async function expectFsCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code })
}

describe('Drive9FileSystem', () => {
  it('requires an explicit workspace credential', () => {
    expect(() => new Drive9FileSystem(new Context(), { apiKey: '', verifyCoherence: false }))
      .toThrow('filesystem apiKey is required')
  })

  it('rejects an unknown mount consistency profile', () => {
    expect(() => new Drive9FileSystem(new Context(), {
      apiKey: 'workspace-key',
      mountConsistency: 'silent-downgrade' as Drive9MountConsistency,
    })).toThrow('mountConsistency must be "strong" or "eventual"')
  })

  it('fails startup for missing, non-directory, and remote-file roots', async () => {
    const { fs, client, mountRoot } = await setup({ verifyCoherence: false })
    const missing = new Drive9FileSystem(new Context(), {
      mountRoot: join(mountRoot, 'missing'), remoteRoot: '/workspace', apiKey: 'workspace-key', verifyCoherence: false,
    }, () => client)
    await expect(missing.initialize()).rejects.toThrow(/not readable and writable/)

    const fileRoot = join(mountRoot, 'not-a-directory')
    await writeFile(fileRoot, 'x')
    const notDirectory = new Drive9FileSystem(new Context(), {
      mountRoot: fileRoot, remoteRoot: '/workspace', apiKey: 'workspace-key', verifyCoherence: false,
    }, () => client)
    await expect(notDirectory.initialize()).rejects.toThrow(/is not a directory/)

    client.setFile('/remote-file', 'x')
    const remoteFile = new Drive9FileSystem(new Context(), {
      mountRoot, remoteRoot: '/remote-file', apiKey: 'workspace-key', verifyCoherence: false,
    }, () => client)
    await expect(remoteFile.initialize()).rejects.toThrow(/is not a directory/)
    await fs.initialize()
  })

  it.skipIf(process.platform === 'win32')('fails startup for a read-only mount root', async () => {
    const { client, mountRoot } = await setup({ verifyCoherence: false })
    await chmod(mountRoot, 0o500)
    try {
      const readOnly = new Drive9FileSystem(new Context(), {
        mountRoot, remoteRoot: '/workspace', apiKey: 'workspace-key', verifyCoherence: false,
      }, () => client)
      await expect(readOnly.initialize()).rejects.toThrow(/not readable and writable/)
    } finally {
      await chmod(mountRoot, 0o700)
    }
  })

  it('proves mount and SDK coherence before becoming usable', async () => {
    const { fs, client } = await setup()
    await fs.initialize()
    expect([...client.nodes].some(([path]) => path.includes('.drive9-dsh-coherence-'))).toBe(false)
  })

  it('cleans the coherence probe through the mount instead of assuming remote-delete invalidation', async () => {
    const { fs, mountRoot } = await setup({ mirrorDeletes: false })
    await expect(fs.initialize()).resolves.toBeUndefined()
    expect(await readdir(mountRoot)).toEqual([])
  })

  it('waits for mount metadata before reading newly committed bytes', async () => {
    const { fs, client, mountRoot } = await setup({ mirrorWrites: false })
    let replacement: Promise<void> | undefined
    client.afterWrite = async (remotePath, data) => {
      if (!remotePath.includes('.drive9-dsh-coherence-')) return
      const localPath = join(mountRoot, remotePath.slice('/workspace/'.length))
      await mkdir(localPath)
      replacement = new Promise(resolve => setTimeout(resolve, 20)).then(async () => {
        await rm(localPath, { recursive: true })
        await writeFile(localPath, data)
      })
    }

    await fs.initialize()
    await replacement
  })

  it('waits for delayed mount propagation after every SDK write and edit path', async () => {
    const { fs, client, mountRoot } = await setup({ mirrorWrites: false })
    const propagated: Promise<void>[] = []
    let workspaceWrites = 0
    client.afterWrite = async (remotePath, data) => {
      const localPath = join(mountRoot, remotePath.slice('/workspace/'.length))
      if (remotePath.includes('.drive9-dsh-coherence-')) {
        await writeFile(localPath, data)
        return
      }

      workspaceWrites += 1
      if (workspaceWrites === 1) await mkdir(localPath)
      const propagation = new Promise(resolve => setTimeout(resolve, 20)).then(async () => {
        await rm(localPath, { force: true, recursive: true })
        await writeFile(localPath, data)
      })
      propagated.push(propagation)
    }

    await fs.initialize()
    const target = await fs.resolve('propagated.txt')
    const created = await fs.writeText(target, 'created', { kind: 'createIfAbsent' })
    await fs.writeText(target, 'unconditional')
    const current = await fs.stat(target)
    expect(current?.version).toBeDefined()
    await fs.editText(
      target,
      { oldString: 'unconditional', newString: 'guarded edit', replaceAll: false },
      { version: current!.version },
    )
    await fs.editText(target, { oldString: 'guarded edit', newString: 'final', replaceAll: false })

    expect(created.operation).toBe('create')
    expect(workspaceWrites).toBe(4)
    await Promise.all(propagated)
    expect(await readFile(fs.processPath(target), 'utf8')).toBe('final')
  })

  it('fails a committed SDK write when the mount never exposes the bytes', async () => {
    const { fs, client, mountRoot } = await setup({ mirrorWrites: false })
    client.afterWrite = async (remotePath, data) => {
      if (!remotePath.includes('.drive9-dsh-coherence-')) return
      const localPath = join(mountRoot, remotePath.slice('/workspace/'.length))
      await writeFile(localPath, data)
    }

    await fs.initialize()
    const target = await fs.resolve('stale-mount.txt')
    await expectFsCode(fs.writeText(target, 'committed remotely', { kind: 'createIfAbsent' }), 'FS_IO_ERROR')
    expect(Buffer.from(client.getFile('/workspace/stale-mount.txt') ?? []).toString('utf8')).toBe('committed remotely')
    await expect(readFile(fs.processPath(target), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('times out when a mount metadata operation never returns', async () => {
    const { fs, client } = await setup({ verifyCoherence: false, hangMountStat: true })
    await fs.initialize()
    const target = await fs.resolve('blocked-mount.txt')

    await expectFsCode(fs.writeText(target, 'committed remotely', { kind: 'createIfAbsent' }), 'FS_IO_ERROR')
    expect(Buffer.from(client.getFile('/workspace/blocked-mount.txt') ?? []).toString('utf8')).toBe('committed remotely')
  }, 1_000)

  it('fails startup when the mount and SDK are not one execution world', async () => {
    const { fs } = await setup({ mirrored: false })
    await expect(fs.initialize()).rejects.toMatchObject({
      message: expect.stringMatching(/coherence proof failed/),
      cause: { code: 'FS_IO_ERROR' },
    })
  })

  it('makes eventual mount consistency explicit and does not wait for process visibility', async () => {
    const { fs, client, context } = await setup({ mirrorWrites: false, mountConsistency: 'eventual' })
    await fs.initialize()
    expect(fs.config).toMatchObject({ mountConsistency: 'eventual', verifyCoherence: false })
    expect(context.logger.buffer).toContainEqual(expect.objectContaining({
      type: 'warn',
      args: [expect.stringMatching(/may remain stale for more than 30 seconds/)],
    }))

    const target = await fs.resolve('eventual.txt')
    await fs.writeText(target, 'committed through the SDK', { kind: 'createIfAbsent' })
    expect(Buffer.from(client.getFile('/workspace/eventual.txt') ?? []).toString('utf8')).toBe('committed through the SDK')
    await expect(readFile(fs.processPath(target), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('honors an explicit coherence proof in eventual mode instead of silently downgrading it', async () => {
    const { fs } = await setup({ mirrored: false, mountConsistency: 'eventual', verifyCoherence: true })
    await expect(fs.initialize()).rejects.toThrow(/coherence proof failed/)
  })

  it('runs the SDK-to-mount leg when eventual mode explicitly requests a coherence proof', async () => {
    const { fs } = await setup({ mirrorWrites: false, mountConsistency: 'eventual', verifyCoherence: true })
    await expect(fs.initialize()).rejects.toMatchObject({
      message: expect.stringMatching(/coherence proof failed/),
      cause: { code: 'FS_IO_ERROR' },
    })
  })

  it('implements create and replace CAS with stable Drive9 revisions', async () => {
    const { fs, client } = await setup()
    await fs.initialize()
    const target = await fs.resolve('notes.txt')
    const created = await fs.writeText(target, 'first\r\nline\r\n', { kind: 'createIfAbsent' })
    expect(created).toMatchObject({ operation: 'create', before: null, after: 'first\nline\n' })
    expect(Buffer.from(client.getFile('/workspace/notes.txt') ?? []).toString()).toBe('first\r\nline\r\n')

    const replaced = await fs.writeText(target, 'second', { kind: 'replaceIfVersion', version: created.version })
    expect(replaced).toMatchObject({ operation: 'update', before: 'first\nline\n', after: 'second' })
    await expectFsCode(fs.writeText(target, 'stale', { kind: 'replaceIfVersion', version: created.version }), 'FS_STALE_VERSION')
    await expectFsCode(fs.writeText(target, 'blind', { kind: 'createIfAbsent' }), 'FS_NOT_OBSERVED')
  })

  it('returns an authenticated target for the exact mounted process path and file URL', async () => {
    const { fs, mountRoot } = await setup()
    await fs.initialize()
    const target = await fs.resolve('dir/file name.txt')
    const expected = join(await realpath(mountRoot), 'dir', 'file name.txt')
    expect(fs.processPath(target)).toBe(expected)
    expect(fs.fileUrl(target)).toBe(pathToFileURL(expected).href)
  })

  it('retries unconditional writes and edits after an external conflict', async () => {
    const { fs, client } = await setup()
    await fs.initialize()
    const target = await fs.resolve('retry.txt')
    await fs.writeText(target, 'alpha', { kind: 'createIfAbsent' })
    let injected = false
    client.beforeWrite = async (path) => {
      if (path !== '/workspace/retry.txt' || injected) return
      injected = true
      client.setFile(path, 'external')
      await writeFile(fs.processPath(target), 'external')
    }
    const outcome = await fs.writeText(target, 'winner')
    expect(outcome.before).toBe('external')
    client.beforeWrite = undefined

    const edited = await fs.editText(target, { oldString: 'winner', newString: 'final', replaceAll: false })
    expect(edited).toMatchObject({ before: 'winner', after: 'final' })
  })

  it('preserves CRLF during literal edits and rejects missing or ambiguous matches', async () => {
    const { fs } = await setup()
    await fs.initialize()
    const target = await fs.resolve('edit.txt')
    const created = await fs.writeText(target, 'one\r\none\r\n', { kind: 'createIfAbsent' })
    await expectFsCode(fs.editText(target, { oldString: 'one', newString: 'two', replaceAll: false }), 'FS_AMBIGUOUS_EDIT')
    await expectFsCode(fs.editText(target, { oldString: 'missing', newString: 'two', replaceAll: false }), 'FS_EDIT_NOT_FOUND')
    const edited = await fs.editText(
      target,
      { oldString: 'one\none', newString: 'two\nthree', replaceAll: false },
      { version: created.version },
    )
    expect(edited.after).toBe('two\nthree\n')
    expect(await fs.readText(target)).toBe('two\r\nthree\r\n')
  })

  it('rejects escapes, forged targets, evidence handles, and symlinks leaving the mount', async () => {
    const { fs, mountRoot } = await setup({ verifyCoherence: false })
    await fs.initialize()
    await expectFsCode(fs.resolve('../outside'), 'FS_SANDBOX_DENIED')
    await expectFsCode(fs.resolve('drive9-result:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), 'FS_SANDBOX_DENIED')
    const valid = await fs.resolve('valid.txt')
    await expectFsCode(Promise.resolve().then(() => fs.processPath({ ...valid, targetKey: `${valid.targetKey}x` as typeof valid.targetKey })), 'FS_IO_ERROR')
    await expectFsCode(Promise.resolve().then(() => fs.processPath({
      targetKey: 'drive9-result:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as typeof valid.targetKey,
      displayPath: 'evidence',
    })), 'FS_IO_ERROR')

    const outside = await mkdtemp(join(tmpdir(), 'drive9-dsh-outside-'))
    roots.push(outside)
    await symlink(outside, join(mountRoot, 'escape'))
    await expectFsCode(fs.resolve('escape/file.txt'), 'FS_SANDBOX_DENIED')
    await expectFsCode(fs.lstat('escape/file.txt'), 'FS_SANDBOX_DENIED')

    await mkdir(join(mountRoot, 'mutable'))
    const minted = await fs.resolve('mutable/file.txt')
    await rm(join(mountRoot, 'mutable'), { recursive: true })
    await symlink(outside, join(mountRoot, 'mutable'))
    await expectFsCode(Promise.resolve().then(() => fs.processPath(minted)), 'FS_IO_ERROR')
  })

  it('uses no-follow local metadata while SDK reads remain strict and bounded', async () => {
    const { fs, client, mountRoot } = await setup()
    await fs.initialize()
    client.setFile('/workspace/binary.bin', Uint8Array.from([0x61, 0x00, 0x62]))
    await writeFile(join(mountRoot, 'binary.bin'), Uint8Array.from([0x61, 0x00, 0x62]))
    const binary = await fs.resolve('binary.bin')
    await expectFsCode(fs.readText(binary), 'FS_NOT_TEXT')
    await expectFsCode(fs.readBytes(binary, undefined, 2), 'FS_TOO_LARGE')
    expect(await fs.readBytes(binary, undefined, 3)).toEqual(Uint8Array.from([0x61, 0x00, 0x62]))

    client.setFile('/workspace/invalid.txt', Uint8Array.from([0xc3, 0x28]))
    await writeFile(join(mountRoot, 'invalid.txt'), Uint8Array.from([0xc3, 0x28]))
    await expectFsCode(fs.readText(await fs.resolve('invalid.txt')), 'FS_NOT_TEXT')

    await symlink('binary.bin', join(mountRoot, 'link'))
    expect(await fs.lstat('link')).toMatchObject({ type: 'symlink' })
  })

  it('streams cross-chunk UTF-8 and returns stable content-free listings', async () => {
    const { fs, client, mountRoot } = await setup()
    await fs.initialize()
    await mkdir(join(mountRoot, 'dir'))
    client.mkdirRecord('/workspace/dir')
    for (const [name, content] of [['z.txt', 'z'], ['a.txt', '🙂']] as const) {
      client.setFile(`/workspace/dir/${name}`, content)
      await writeFile(join(mountRoot, 'dir', name), content)
    }
    const target = await fs.resolve('dir/a.txt')
    let streamed = ''
    for await (const chunk of await fs.streamText(target)) streamed += chunk
    expect(streamed).toBe('🙂')
    const entries = await fs.listDir(await fs.resolve('dir'))
    expect(entries.map(entry => entry.name)).toEqual(['a.txt', 'z.txt'])
    expect(entries.every(entry => entry.version !== undefined && entry.target !== undefined)).toBe(true)
  })

  it('chunks large directory metadata requests at the Drive9 batch limit', async () => {
    const { fs, client, mountRoot } = await setup()
    await fs.initialize()
    await mkdir(join(mountRoot, 'many'))
    client.mkdirRecord('/workspace/many')
    for (let index = 0; index < 257; index += 1) {
      const name = `${String(index).padStart(3, '0')}.txt`
      client.setFile(`/workspace/many/${name}`, name)
      await writeFile(join(mountRoot, 'many', name), name)
    }
    const entries = await fs.listDir(await fs.resolve('many'))
    expect(entries).toHaveLength(257)
    expect(client.batchStatCalls.map(paths => paths.length)).toEqual([256, 1])
  })

  it('rejects streamed NUL bytes and incomplete UTF-8 tails', async () => {
    const { fs, client, mountRoot } = await setup()
    await fs.initialize()
    for (const [name, bytes] of [
      ['nul.txt', Uint8Array.from([0x61, 0x62, 0x00, 0x63])],
      ['truncated.txt', Uint8Array.from([0x61, 0x62, 0xf0, 0x9f])],
    ] as const) {
      client.setFile(`/workspace/${name}`, bytes)
      await writeFile(join(mountRoot, name), bytes)
      const chunks = await fs.streamText(await fs.resolve(name))
      await expect((async () => {
        for await (const _chunk of chunks) {}
      })()).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    }
  })

  it('maps cancellation, permission, and backend errors to stable filesystem codes', async () => {
    const { fs, client } = await setup()
    await fs.initialize()
    const controller = new AbortController()
    controller.abort()
    await expectFsCode(fs.resolve('x', { signal: controller.signal }), 'FS_ABORTED')

    const denied = await fs.resolve('denied.txt')
    await fs.writeText(denied, 'x', { kind: 'createIfAbsent' })
    client.beforeRead = () => { throw new FakeStatusError('secret header must not leak', 403) }
    await expectFsCode(fs.readText(denied), 'FS_PERMISSION_DENIED')
    client.beforeRead = () => { throw new Error('backend unavailable') }
    await expectFsCode(fs.readText(denied), 'FS_IO_ERROR')
  })
})
