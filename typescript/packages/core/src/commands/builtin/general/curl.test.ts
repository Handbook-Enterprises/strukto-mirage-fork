// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IOResult, materialize } from '../../../io/types.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { GENERAL_CURL } from './curl.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

interface FetchCall {
  url: string
  init?: RequestInit
}

function mockFetch(respBody: string, status = 200): FetchCall[] {
  const calls: FetchCall[] = []
  globalThis.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    calls.push({ url: urlStr, ...(init !== undefined ? { init } : {}) })
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      arrayBuffer: () => Promise.resolve(ENC.encode(respBody).buffer),
      text: () => Promise.resolve(respBody),
      headers: new Headers(),
    } as unknown as Response)
  }) as typeof fetch
  return calls
}

async function runCurl(
  texts: string[],
  flags: Record<string, string | boolean> = {},
): Promise<{
  out: string
  exitCode: number
  writes: Record<string, Uint8Array | AsyncIterable<Uint8Array>>
}> {
  const resource = new RAMResource()
  const cmd = GENERAL_CURL[0]
  if (cmd === undefined) throw new Error('curl not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], texts, {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return { out: '', exitCode: -1, writes: {} }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), exitCode: ioResult.exitCode, writes: ioResult.writes }
}

describe('curl', () => {
  const original = globalThis.fetch
  beforeEach(() => {
    mockFetch('hello body')
  })
  afterEach(() => {
    globalThis.fetch = original
  })

  it('GET returns body', async () => {
    const r = await runCurl(['https://x.test/hi'])
    expect(r.out).toBe('hello body')
    expect(r.exitCode).toBe(0)
  })

  it('-o writes to file instead of stdout', async () => {
    const r = await runCurl(['https://x.test/file'], { o: '/tmp/out.txt' })
    const written = r.writes['/tmp/out.txt']
    expect(written).toBeInstanceOf(Uint8Array)
    if (written instanceof Uint8Array) {
      expect(DEC.decode(written)).toBe('hello body')
    }
    // Like curl, -o prints nothing to stdout.
    expect(r.out).toBe('')
  })

  it('-s with -o silences stdout', async () => {
    const r = await runCurl(['https://x.test/x'], { o: '/tmp/o', s: true })
    expect(r.out).toBe('')
  })

  it('-X POST -d sends body', async () => {
    const calls = mockFetch('ok')
    const r = await runCurl(['https://x.test/p'], { X: 'POST', d: 'payload' })
    expect(r.exitCode).toBe(0)
    expect(calls[0]?.init?.method).toBe('POST')
    expect(new TextDecoder().decode(calls[0]?.init?.body as ArrayBuffer)).toBe('payload')
  })

  it('-H adds headers', async () => {
    const calls = mockFetch('ok')
    await runCurl(['https://x.test/p'], { H: 'X-Auth: token' })
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['X-Auth']).toBe('token')
  })

  it('sends default Mozilla User-Agent when none provided', async () => {
    const calls = mockFetch('ok')
    await runCurl(['https://x.test/p'])
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['User-Agent']).toMatch(/^Mozilla\/5\.0/)
  })

  it('-A overrides default User-Agent', async () => {
    const calls = mockFetch('ok')
    await runCurl(['https://x.test/p'], { A: 'my-agent/9' })
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('my-agent/9')
  })

  it('-H User-Agent overrides default', async () => {
    const calls = mockFetch('ok')
    await runCurl(['https://x.test/p'], { H: 'User-Agent: from-H/1' })
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('from-H/1')
  })

  it('missing URL returns exit 2', async () => {
    const r = await runCurl([])
    expect(r.exitCode).toBe(2)
  })
})

describe('curl argv parsing (real curl semantics)', () => {
  const original = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = original
  })

  function mockStatus(status: number, body: string, headers: Record<string, string> = {}) {
    const calls: FetchCall[] = []
    globalThis.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      calls.push({ url: urlStr, ...(init !== undefined ? { init } : {}) })
      return Promise.resolve(
        new Response(body, { status, statusText: status === 200 ? 'OK' : 'Bad Request', headers }),
      )
    }) as typeof fetch
    return calls
  }

  async function curl(
    argv: string[],
    files: Record<string, string> = {},
    stdin: string | null = null,
  ): Promise<{ out: string; err: string; exitCode: number; written: Record<string, string> }> {
    const resource = new RAMResource()
    const written: Record<string, string> = {}
    const cmd = GENERAL_CURL[0]
    if (cmd === undefined) throw new Error('curl not registered')
    const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], argv, {
      stdin: stdin === null ? null : ENC.encode(stdin),
      flags: {},
      filetypeFns: null,
      cwd: '/data',
      resource,
      dispatch: (op, path, args) => {
        if (op === 'read') {
          const text = files[path.original]
          if (text === undefined) return Promise.reject(new Error(`ENOENT: ${path.original}`))
          return Promise.resolve([ENC.encode(text), new IOResult()])
        }
        written[path.original] = DEC.decode(
          (args?.[0] as Uint8Array | undefined) ?? new Uint8Array(),
        )
        return Promise.resolve([null, new IOResult()])
      },
    })
    if (result === null) throw new Error('no result')
    const [out, io] = result
    const buf =
      out === null ? new Uint8Array() : await materialize(out as AsyncIterable<Uint8Array>)
    const err = io.stderr instanceof Uint8Array ? DEC.decode(io.stderr) : ''
    return { out: DEC.decode(buf), err, exitCode: io.exitCode, written }
  }

  it('sends every repeated -H header', async () => {
    const calls = mockStatus(200, 'ok')
    await curl(['-H', 'X-A: 1', '-H', 'X-B: 2', '--header', 'X-C: 3', 'https://x.test/'])
    const h = calls[0]?.init?.headers as Record<string, string>
    expect([h['X-A'], h['X-B'], h['X-C']]).toEqual(['1', '2', '3'])
  })

  it('reads -d @file and --data-binary @file through the VFS', async () => {
    const calls = mockStatus(200, 'ok')
    const files = { '/data/p.json': '{"text":"hi"}\n' }
    await curl(['-X', 'POST', '-d', '@p.json', 'https://x.test/'], files)
    expect(DEC.decode(calls[0]?.init?.body as Uint8Array)).toBe('{"text":"hi"}')
    await curl(['--data-binary', '@/data/p.json', 'https://x.test/'], files)
    expect(DEC.decode(calls[1]?.init?.body as Uint8Array)).toBe('{"text":"hi"}\n')
  })

  it('reads -d @- from stdin', async () => {
    const calls = mockStatus(200, 'ok')
    await curl(['-d', '@-', 'https://x.test/'], {}, '{"from":"stdin"}')
    expect(DEC.decode(calls[0]?.init?.body as Uint8Array)).toBe('{"from":"stdin"}')
  })

  it('keeps --data-raw literal, even with a leading @', async () => {
    const calls = mockStatus(200, 'ok')
    await curl(['--data-raw', '@not-a-file', 'https://x.test/'])
    expect(DEC.decode(calls[0]?.init?.body as Uint8Array)).toBe('@not-a-file')
  })

  it('--json sets JSON headers and POSTs', async () => {
    const calls = mockStatus(200, 'ok')
    await curl(['--json', '{"a":1}', 'https://x.test/'])
    const h = calls[0]?.init?.headers as Record<string, string>
    expect(calls[0]?.init?.method).toBe('POST')
    expect(h['Content-Type']).toBe('application/json')
  })

  it('prints the body and exits 0 on HTTP 400 without -f', async () => {
    mockStatus(400, 'invalid_payload')
    const r = await curl(['-s', '-d', 'x', 'https://x.test/'])
    expect(r).toMatchObject({ out: 'invalid_payload', exitCode: 0 })
  })

  it('exits 22 with -f on HTTP 400, like curl', async () => {
    mockStatus(400, 'invalid_payload')
    const r = await curl(['-sSf', 'https://x.test/'])
    expect(r.exitCode).toBe(22)
    expect(r.err).toContain('returned error: 400')
  })

  it('supports -w %{http_code} with -o', async () => {
    mockStatus(400, 'invalid_payload')
    const r = await curl(['-s', '-o', 'resp.txt', '-w', '%{http_code}', 'https://x.test/'])
    expect(r).toMatchObject({ out: '400', exitCode: 0 })
    expect(r.written['/data/resp.txt']).toBe('invalid_payload')
  })

  it('-i includes the status line and headers', async () => {
    mockStatus(200, 'body', { 'content-type': 'text/plain' })
    const r = await curl(['-i', 'https://x.test/'])
    expect(r.out).toMatch(/^HTTP\/1\.1 200 OK\r\n/)
    expect(r.out).toContain('content-type: text/plain')
    expect(r.out.endsWith('body')).toBe(true)
  })

  it('rejects an unknown option instead of treating it as the URL', async () => {
    const r = await curl(['--frobnicate', 'https://x.test/'])
    expect(r.exitCode).toBe(2)
    expect(r.err).toContain('--frobnicate: is unknown')
  })

  it('accepts bundled short flags and attached values', async () => {
    const calls = mockStatus(200, 'ok')
    const r = await curl(['-sSL', '-XPUT', 'https://x.test/'])
    expect(r.exitCode).toBe(0)
    expect(calls[0]?.init?.method).toBe('PUT')
  })

  it('--fail-with-body exits 22 and still prints the error body', async () => {
    mockStatus(400, 'invalid_payload')
    const r = await curl(['-s', '--fail-with-body', 'https://x.test/'])
    expect(r).toMatchObject({ out: 'invalid_payload', exitCode: 22 })
  })

  it('--data-binary @file sends non-UTF-8 bytes unchanged', async () => {
    const calls = mockStatus(200, 'ok')
    const resource = new RAMResource()
    const bytes = Uint8Array.from([0xff, 0x00, 0x0a, 0x80])
    const cmd = GENERAL_CURL[0]
    if (cmd === undefined) throw new Error('curl not registered')
    await cmd.fn(
      (resource as { accessor?: unknown }).accessor as never,
      [],
      ['--data-binary', '@/data/b.bin', 'https://x.test/'],
      {
        stdin: null,
        flags: {},
        filetypeFns: null,
        cwd: '/',
        resource,
        dispatch: () => Promise.resolve([bytes, new IOResult()]),
      },
    )
    expect(Array.from(calls[0]?.init?.body as Uint8Array)).toEqual([0xff, 0x00, 0x0a, 0x80])
  })

  it('an empty -H value suppresses the default header', async () => {
    const calls = mockStatus(200, 'ok')
    await curl(['-H', 'User-Agent:', '-H', 'Content-Type:', '-d', 'x', 'https://x.test/'])
    const h = calls[0]?.init?.headers as Record<string, string>
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('user-agent')
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('content-type')
  })

  it('-F sends multipart form data with file parts', async () => {
    const calls = mockStatus(200, 'ok')
    await curl(['-F', 'note=hi', '-F', 'doc=@/data/a.txt', 'https://x.test/'], {
      '/data/a.txt': 'file body',
    })
    const body = calls[0]?.init?.body
    expect(body).toBeInstanceOf(FormData)
    const form = body as FormData
    expect(form.get('note')).toBe('hi')
    const file = form.get('doc') as File
    expect(file.name).toBe('a.txt')
    expect(await file.text()).toBe('file body')
  })

  it('-s hides transport errors unless -S, keeping the exit code', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND')),
    ) as typeof fetch
    const quiet = await curl(['-s', 'https://nope.test/'])
    expect(quiet).toMatchObject({ exitCode: 6, err: '' })
    const shown = await curl(['-sS', 'https://nope.test/'])
    expect(shown.exitCode).toBe(6)
    expect(shown.err).toContain('ENOTFOUND')
  })
})
