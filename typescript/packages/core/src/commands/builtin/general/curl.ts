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

import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { httpExchange, type HttpExchange } from '../utils/http.ts'
import { readStdinAsync } from '../utils/stream.ts'

// curl reads its own argv, like the real binary. The spec declares no options
// (see commands/spec/builtins.ts), so the shell parser hands every token to
// this command in order. A short option table used to drop repeated -H, read
// `-d @file` as the literal text "@file", reject -w as a URL, and turn every
// 4xx/5xx into exit 22 with the response body discarded.

const ENC = new TextEncoder()
const DEC = new TextDecoder()

export function resolveTarget(o: string, cwd: string): PathSpec {
  let path = o
  if (!o.startsWith('/')) {
    const base = cwd.replace(/\/+$/, '')
    path = base !== '' ? `${base}/${o}` : `/${o}`
  }
  const lastSlash = path.lastIndexOf('/')
  const directory = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '/'
  return new PathSpec({ original: path, directory, resolved: true })
}

type DataKind = 'data' | 'binary' | 'raw' | 'urlencode' | 'json'

interface CurlArgs {
  url: string | null
  method: string | null
  headers: string[]
  data: { kind: DataKind; value: string }[]
  form: string[]
  output: string | null
  writeOut: string | null
  user: string | null
  maxTimeSec: number | null
  location: boolean
  silent: boolean
  showError: boolean
  fail: boolean
  failWithBody: boolean
  include: boolean
  head: boolean
  verbose: boolean
  get: boolean
  jina: boolean
}

// Options that take a value, by every spelling curl accepts.
const VALUE_OPTS: Record<string, string> = {
  '-X': 'method',
  '--request': 'method',
  '-H': 'header',
  '--header': 'header',
  '-d': 'data',
  '--data': 'data',
  '--data-ascii': 'data',
  '--data-binary': 'binary',
  '--data-raw': 'raw',
  '--data-urlencode': 'urlencode',
  '--json': 'json',
  '-F': 'form',
  '--form': 'form',
  '-o': 'output',
  '--output': 'output',
  '-w': 'writeOut',
  '--write-out': 'writeOut',
  '-A': 'agent',
  '--user-agent': 'agent',
  '-e': 'referer',
  '--referer': 'referer',
  '-b': 'cookie',
  '--cookie': 'cookie',
  '-u': 'user',
  '--user': 'user',
  '-m': 'maxTime',
  '--max-time': 'maxTime',
  '--connect-timeout': 'ignoreValue',
  '--retry': 'ignoreValue',
  '--url': 'url',
}

const BOOL_OPTS: Record<string, keyof CurlArgs | null> = {
  '-L': 'location',
  '--location': 'location',
  '-s': 'silent',
  '--silent': 'silent',
  '-S': 'showError',
  '--show-error': 'showError',
  '-f': 'fail',
  '--fail': 'fail',
  '--fail-with-body': 'failWithBody',
  '-i': 'include',
  '--include': 'include',
  '-I': 'head',
  '--head': 'head',
  '-v': 'verbose',
  '--verbose': 'verbose',
  '-G': 'get',
  '--get': 'get',
  '--jina': 'jina',
  // Accepted and ignored: no effect in this runtime.
  '-k': null,
  '--insecure': null,
  '--compressed': null,
  '-#': null,
  '--progress-bar': null,
  '-N': null,
  '--no-buffer': null,
}

function emptyArgs(): CurlArgs {
  return {
    url: null,
    method: null,
    headers: [],
    data: [],
    form: [],
    output: null,
    writeOut: null,
    user: null,
    maxTimeSec: null,
    location: false,
    silent: false,
    showError: false,
    fail: false,
    failWithBody: false,
    include: false,
    head: false,
    verbose: false,
    get: false,
    jina: false,
  }
}

function applyValue(args: CurlArgs, key: string, value: string): string | null {
  switch (key) {
    case 'method':
      args.method = value
      return null
    case 'header':
      args.headers.push(value)
      return null
    case 'data':
    case 'binary':
    case 'raw':
    case 'urlencode':
    case 'json':
      args.data.push({ kind: key, value })
      return null
    case 'form':
      args.form.push(value)
      return null
    case 'output':
      args.output = value
      return null
    case 'writeOut':
      args.writeOut = value
      return null
    case 'agent':
      args.headers.push(`User-Agent: ${value}`)
      return null
    case 'referer':
      args.headers.push(`Referer: ${value}`)
      return null
    case 'cookie':
      args.headers.push(`Cookie: ${value}`)
      return null
    case 'user':
      args.user = value
      return null
    case 'maxTime': {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0)
        return `curl: option --max-time: expected a number, got '${value}'`
      args.maxTimeSec = n
      return null
    }
    case 'url':
      args.url = value
      return null
    default:
      return null
  }
}

/** Parse curl argv. Returns the args or an error message (curl exit 2). */
export function parseCurlArgv(argv: readonly string[]): CurlArgs | string {
  const args = emptyArgs()
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? ''
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=')
      const name = eq > 0 ? tok.slice(0, eq) : tok
      if (name in BOOL_OPTS) {
        const key = BOOL_OPTS[name]
        if (key !== null && key !== undefined)
          (args as unknown as Record<string, unknown>)[key] = true
        continue
      }
      const valueKey = VALUE_OPTS[name]
      if (valueKey === undefined) return `curl: option ${name}: is unknown`
      const value = eq > 0 ? tok.slice(eq + 1) : argv[++i]
      if (value === undefined) return `curl: option ${name}: requires parameter`
      const err = applyValue(args, valueKey, value)
      if (err !== null) return err
      continue
    }
    if (tok.startsWith('-') && tok.length > 1) {
      // Bundled short flags (-sS, -sSL) and attached values (-XPOST, -osome.txt).
      for (let j = 1; j < tok.length; j++) {
        const flag = `-${tok[j] ?? ''}`
        if (flag in BOOL_OPTS) {
          const key = BOOL_OPTS[flag]
          if (key !== null && key !== undefined)
            (args as unknown as Record<string, unknown>)[key] = true
          continue
        }
        const valueKey = VALUE_OPTS[flag]
        if (valueKey === undefined) return `curl: option ${flag}: is unknown`
        const rest = tok.slice(j + 1)
        const value = rest !== '' ? rest : argv[++i]
        if (value === undefined) return `curl: option ${flag}: requires parameter`
        const err = applyValue(args, valueKey, value)
        if (err !== null) return err
        break
      }
      continue
    }
    if (args.url === null) args.url = tok
    else return `curl: only one URL per call is supported here (got '${tok}')`
  }
  return args
}

/** Old callers pass already-parsed flags; turn them back into argv. */
function legacyArgv(flags: Record<string, string | boolean>): string[] {
  const argv: string[] = []
  for (const [k, v] of Object.entries(flags)) {
    const flag = k.length === 1 ? `-${k}` : `--${k.replaceAll('_', '-')}`
    if (v === true) argv.push(flag)
    else if (typeof v === 'string') argv.push(flag, v)
  }
  return argv
}

async function readSource(spec: string, opts: CommandOpts): Promise<Uint8Array> {
  if (spec === '-') {
    const bytes = await readStdinAsync(opts.stdin)
    return bytes ?? new Uint8Array()
  }
  if (opts.dispatch === undefined) throw new Error(`cannot read ${spec}`)
  const [value] = await opts.dispatch('read', resolveTarget(spec, opts.cwd))
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') return ENC.encode(value)
  throw new Error(`cannot read ${spec}`)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.byteLength
  }
  return out
}

/**
 * The request body as bytes, joined with `&` the way curl joins -d values.
 * Bytes stay bytes: only text modes are decoded, so `--data-binary @file`
 * uploads a binary file unchanged.
 */
async function buildBody(args: CurlArgs, opts: CommandOpts): Promise<Uint8Array | null> {
  if (args.data.length === 0) return null
  const parts: Uint8Array[] = []
  for (const { kind, value } of args.data) {
    if (parts.length > 0) parts.push(ENC.encode('&'))
    if (kind === 'raw') {
      parts.push(ENC.encode(value))
    } else if (kind === 'urlencode') {
      const eq = value.indexOf('=')
      const at = value.indexOf('@')
      if (eq >= 0) {
        parts.push(
          ENC.encode(`${value.slice(0, eq + 1)}${encodeURIComponent(value.slice(eq + 1))}`),
        )
      } else if (at >= 0) {
        const content = DEC.decode(await readSource(value.slice(at + 1), opts))
        const name = value.slice(0, at)
        parts.push(ENC.encode(`${name !== '' ? `${name}=` : ''}${encodeURIComponent(content)}`))
      } else {
        parts.push(ENC.encode(encodeURIComponent(value)))
      }
    } else if (value.startsWith('@')) {
      const content = await readSource(value.slice(1), opts)
      // -d/--data strips CR and LF from a file; --data-binary and --json keep every byte.
      parts.push(kind === 'data' ? content.filter((b) => b !== 0x0a && b !== 0x0d) : content)
    } else {
      parts.push(ENC.encode(value))
    }
  }
  return concat(parts)
}

/** -F fields as multipart/form-data: `name=value`, `name=@file` (file part), `name=<file` (contents). */
async function buildForm(args: CurlArgs, opts: CommandOpts): Promise<FormData> {
  const form = new FormData()
  for (const field of args.form) {
    const eq = field.indexOf('=')
    const name = eq >= 0 ? field.slice(0, eq) : field
    const value = eq >= 0 ? field.slice(eq + 1) : ''
    if (value.startsWith('@')) {
      const spec = value.slice(1).split(';')[0] ?? ''
      const bytes = await readSource(spec, opts)
      form.append(
        name,
        new Blob([bytes.slice().buffer]),
        spec.slice(spec.lastIndexOf('/') + 1) || 'file',
      )
    } else if (value.startsWith('<')) {
      form.append(name, DEC.decode(await readSource(value.slice(1), opts)))
    } else {
      form.append(name, value)
    }
  }
  return form
}

/**
 * Final request headers plus the names explicitly removed with an empty value
 * (`-H 'Content-Type:'`), so curl's defaults are not re-added for them. Keyed
 * case-insensitively; a later -H for the same name replaces the earlier one.
 */
function headerMap(lines: string[]): { headers: Record<string, string>; removed: Set<string> } {
  const byName = new Map<string, [string, string]>()
  const removed = new Set<string>()
  for (const line of lines) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const name = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    const key = name.toLowerCase()
    if (value === '') {
      byName.delete(key)
      removed.add(key)
    } else {
      byName.set(key, [name, value])
      removed.delete(key)
    }
  }
  return { headers: Object.fromEntries(byName.values()), removed }
}

function headerBlock(ex: HttpExchange): string {
  const lines = [`HTTP/1.1 ${String(ex.status)} ${ex.statusText}`.trimEnd()]
  for (const [k, v] of ex.headers) lines.push(`${k}: ${v}`)
  return `${lines.join('\r\n')}\r\n\r\n`
}

function writeOut(format: string, ex: HttpExchange): string {
  const vars: Record<string, string> = {
    http_code: String(ex.status),
    response_code: String(ex.status),
    url_effective: ex.url,
    size_download: String(ex.body.byteLength),
    content_type: ex.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '',
  }
  return format
    .replace(/%\{(\w+)\}/g, (m, name: string) => vars[name] ?? m)
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
}

function fail(message: string, exitCode: number, quiet = false): CommandFnResult {
  // curl -s hides error messages (unless -S); the exit code still reports it.
  if (quiet) return [null, new IOResult({ exitCode })]
  return [null, new IOResult({ exitCode, stderr: ENC.encode(`${message}\n`) })]
}

async function curlCommand(
  _accessor: Accessor,
  _paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const parsed = parseCurlArgv([...legacyArgv(opts.flags), ...texts])
  if (typeof parsed === 'string') return fail(parsed, 2)
  const args = parsed
  if (args.url === null) return fail('curl: no URL specified', 2)
  const quiet = args.silent && !args.showError

  const { headers, removed } = headerMap(args.headers)
  const has = (name: string): boolean =>
    removed.has(name) || Object.keys(headers).some((k) => k.toLowerCase() === name)
  if (args.user !== null && !has('authorization')) {
    headers.Authorization = `Basic ${btoa(args.user)}`
  }

  let body: Uint8Array | FormData | null
  try {
    if (args.form.length > 0) {
      // fetch sets the multipart Content-Type (with boundary) itself.
      body = await buildForm(args, opts)
    } else {
      body = await buildBody(args, opts)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return fail(`curl: (26) ${msg}`, 26, quiet)
  }
  const isJson = args.data.some((d) => d.kind === 'json')
  if (isJson) {
    if (!has('content-type')) headers['Content-Type'] = 'application/json'
    if (!has('accept')) headers.Accept = 'application/json'
  } else if (body instanceof Uint8Array && !has('content-type')) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }

  let url = args.url
  if (args.get && body instanceof Uint8Array) {
    url = `${url}${url.includes('?') ? '&' : '?'}${DEC.decode(body)}`
    body = null
  }
  const method = args.head ? 'HEAD' : (args.method ?? (body !== null ? 'POST' : 'GET'))
  const timeoutMs = args.maxTimeSec !== null ? args.maxTimeSec * 1000 : undefined

  let ex: HttpExchange
  try {
    ex = await httpExchange(url, {
      method,
      headers,
      ...(body !== null ? { body } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      jina: args.jina,
      followRedirects: args.location,
      omitUserAgent: removed.has('user-agent'),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const timedOut = msg.toLowerCase().includes('abort')
    return fail(
      timedOut ? 'curl: (28) Operation timed out' : `curl: (6) ${msg}`,
      timedOut ? 28 : 6,
      quiet,
    )
  }

  const stderr: string[] = []
  if (args.verbose) {
    stderr.push(`> ${method} ${url}`)
    for (const [k, v] of Object.entries(headers)) stderr.push(`> ${k}: ${v}`)
    stderr.push(`< HTTP/1.1 ${String(ex.status)} ${ex.statusText}`.trimEnd())
    for (const [k, v] of ex.headers) stderr.push(`< ${k}: ${v}`)
  }
  const failed = (args.fail || args.failWithBody) && ex.status >= 400
  if (failed && !quiet) {
    stderr.push(`curl: (22) The requested URL returned error: ${String(ex.status)}`)
  }

  const shown: Uint8Array[] = []
  if (args.include || args.head) shown.push(ENC.encode(headerBlock(ex)))
  // --fail suppresses the error body; --fail-with-body keeps it.
  if (!args.head && (!failed || args.failWithBody)) shown.push(ex.body)
  const payload = concat(shown)

  const out: Uint8Array[] = []
  const io: { writes?: Record<string, Uint8Array> } = {}
  if (args.output !== null && args.output !== '-') {
    if (opts.dispatch !== undefined) {
      try {
        await opts.dispatch('write', resolveTarget(args.output, opts.cwd), [payload])
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return fail(`curl: (23) ${args.output}: ${errMsg}`, 23, quiet)
      }
    }
    io.writes = { [args.output]: payload }
  } else {
    out.push(payload)
  }
  if (args.writeOut !== null) out.push(ENC.encode(writeOut(args.writeOut, ex)))
  return [
    concat(out),
    new IOResult({
      exitCode: failed ? 22 : 0,
      ...(stderr.length > 0 ? { stderr: ENC.encode(`${stderr.join('\n')}\n`) } : {}),
      ...io,
    }),
  ]
}

export const GENERAL_CURL = command({
  name: 'curl',
  resource: null,
  spec: specOf('curl'),
  fn: curlCommand,
})
