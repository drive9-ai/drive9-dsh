import { createServer, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import type { ExecRequest, RuntimeCapabilities } from 'drive9'

/** Local HTTP protocol fixture, executing Bash only in the test-owned directory. */
export async function runtimeProtocolFixture(root: string, caps: RuntimeCapabilities) {
  const requests: ExecRequest[] = []
  let cancelCount = 0
  const running = new Map<string, () => Promise<void>>()
  function frame(res: ServerResponse, value: object) { res.write(JSON.stringify(value) + '\n') }
  const server = createServer((req, res) => { void handle().catch(error => { res.destroy(error) })
    async function handle() {
      if (req.url === '/v1/runtime/capabilities') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(caps)); return }
      if (req.url === '/v1/status') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ tenant_id: req.headers.authorization?.includes('evidence') ? 'evidence' : 'workspace' })); return }
      if (req.url?.endsWith('/cancel')) {
        cancelCount++
        const id = req.url.split('/')[4]!
        const cancel = running.get(id)
        if (!cancel) { res.writeHead(404); res.end('{}'); return }
        await cancel(); res.end('{"canceled":true}'); return
      }
      if (req.url !== '/v1/runtime/exec') { res.writeHead(404); res.end(); return }
      let body = ''
      for await (const chunk of req) body += chunk
      const request = JSON.parse(body) as ExecRequest
      requests.push(request)
      const id = `rex_fixture_${requests.length}`
      res.setHeader('Content-Type', 'application/x-ndjson')
      frame(res, { type: 'started', execution_id: id, cwd: root, sandbox: 'new' })
      if (request.argv?.[2] === '__fixture_engine_error__') {
        frame(res, { type: 'stdout', execution_id: id, data_base64: Buffer.from('partial-output').toString('base64') })
        frame(res, { type: 'error', execution_id: id, error_code: 'engine_error', message: 'matching work limit exceeded' }); res.end(); return
      }
      const child = spawn(request.argv![0]!, request.argv!.slice(1), { cwd: join(root, request.cwd ?? '.'), env: { PATH: process.env.PATH, ...request.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
      const closed = once(child, 'close')
      running.set(id, async () => { if (child.exitCode === null) process.kill(-child.pid!, 'SIGTERM'); await closed })
      child.stdout.on('data', chunk => frame(res, { type: 'stdout', execution_id: id, data_base64: chunk.toString('base64') }))
      child.stderr.on('data', chunk => frame(res, { type: 'stderr', execution_id: id, data_base64: chunk.toString('base64') }))
      const [code] = await closed
      running.delete(id)
      if (code !== null) frame(res, { type: 'exit', execution_id: id, exit_code: code, duration_ms: 1 })
      else frame(res, { type: 'error', execution_id: id, error_code: 'canceled', message: 'fixture process stopped' })
      res.end()
    }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture has no port')
  return {
    url: `http://127.0.0.1:${address.port}`, requests, get cancelCount() { return cancelCount },
    async close() { await Promise.all([...running.values()].map(cancel => cancel())); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) },
  }
}
