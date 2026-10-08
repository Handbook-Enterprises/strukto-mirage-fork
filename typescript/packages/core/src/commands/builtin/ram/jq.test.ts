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

import { describe, expect, it } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { parseCommand, parseToKwargs } from '../../spec/parser.ts'
import { specOf } from '../../spec/builtins.ts'
import { PathSpec } from '../../../types.ts'
import { RAM_JQ } from './jq.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function kwargsFor(cmdline: string): Record<string, string | boolean> {
  const argv = cmdline.split(' ').slice(1)
  return parseToKwargs(parseCommand(specOf('jq'), argv, '/'))
}

async function runJq(
  resource: RAMResource,
  program: string,
  paths: PathSpec[],
  flags: Record<string, string | boolean> = {},
  stdin: Uint8Array | null = null,
): Promise<{ out: string; exitCode: number }> {
  const cmd = RAM_JQ[0]
  if (cmd === undefined) throw new Error('jq not registered')
  const result = await cmd.fn(
    (resource as { accessor?: unknown }).accessor as never,
    paths,
    [program],
    { stdin, flags, filetypeFns: null, cwd: '/', resource },
  )
  if (result === null) return { out: '', exitCode: -1 }
  const [out, io] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), exitCode: io.exitCode }
}

describe('jq spec/parser — standard flags', () => {
  it('parses -n / --null-input', () => {
    expect(kwargsFor('jq -n 1+1').n).toBe(true)
    expect(kwargsFor('jq --null-input 1+1').null_input).toBe(true)
  })

  it('parses --arg name value into a JSON tuple list', () => {
    const k = kwargsFor('jq --arg who Alice .')
    expect(JSON.parse(k.arg as string)).toEqual([['who', 'Alice']])
  })

  it('collects repeated --arg occurrences in order', () => {
    const k = kwargsFor('jq --arg a 1 --arg b 2 .')
    expect(JSON.parse(k.arg as string)).toEqual([
      ['a', '1'],
      ['b', '2'],
    ])
  })

  it('parses --argjson name json', () => {
    const k = kwargsFor('jq --argjson num 5 .')
    expect(JSON.parse(k.argjson as string)).toEqual([['num', '5']])
  })

  it('parses --rawfile name file and resolves the file path', () => {
    const parsed = parseCommand(specOf('jq'), ['--rawfile', 'data', 'vars.txt', '.'], '/work')
    const k = parseToKwargs(parsed)
    expect(JSON.parse(k.rawfile as string)).toEqual([['data', '/work/vars.txt']])
    // The rawfile path is surfaced for cache routing.
    expect(parsed.routingPaths()).toContain('/work/vars.txt')
  })

  it('still parses -r / -c / -s', () => {
    expect(kwargsFor('jq -r .').r).toBe(true)
    expect(kwargsFor('jq -c .').c).toBe(true)
    expect(kwargsFor('jq -s .').s).toBe(true)
  })
})

describe('jq command — flag behavior', () => {
  it('-n evaluates without input (jq -n 1+1)', async () => {
    const resource = new RAMResource()
    const r = await runJq(resource, '1+1', [], { n: true })
    expect(r.exitCode).toBe(0)
    expect(r.out.trim()).toBe('2')
  })

  it('--arg binds a string variable', async () => {
    const resource = new RAMResource()
    const r = await runJq(resource, '$who', [], {
      n: true,
      r: true,
      arg: JSON.stringify([['who', 'Alice']]),
    })
    expect(r.out.trim()).toBe('Alice')
  })

  it('--argjson binds a JSON variable', async () => {
    const resource = new RAMResource()
    const r = await runJq(resource, '$num + 1', [], {
      n: true,
      argjson: JSON.stringify([['num', '5']]),
    })
    expect(r.out.trim()).toBe('6')
  })

  it('--rawfile reads the file contents through the VFS as a string', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/raw.txt', ENC.encode('hello\nworld\n'))
    const r = await runJq(resource, '$data', [], {
      n: true,
      rawfile: JSON.stringify([['data', '/tmp/raw.txt']]),
    })
    expect(r.exitCode).toBe(0)
    expect(JSON.parse(r.out.trim())).toBe('hello\nworld\n')
  })

  it('--rawfile on a missing file exits nonzero', async () => {
    const resource = new RAMResource()
    const r = await runJq(resource, '$data', [], {
      n: true,
      rawfile: JSON.stringify([['data', '/tmp/nope.txt']]),
    })
    // jq exits 2 when it cannot open a file.
    expect(r.exitCode).toBe(2)
  })

  it('reads a direct file operand', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/d.json', ENC.encode('{"a":41}'))
    const r = await runJq(resource, '.a + 1', [PathSpec.fromStrPath('/tmp/d.json')])
    expect(r.out.trim()).toBe('42')
  })

  it('reads JSON from stdin (piping)', async () => {
    const resource = new RAMResource()
    const r = await runJq(resource, '.a', [], {}, ENC.encode('{"a":7}'))
    expect(r.out.trim()).toBe('7')
  })

  it('-s slurps a single value into a one-element array', async () => {
    const resource = new RAMResource()
    const r = await runJq(resource, 'length', [], { s: true }, ENC.encode('5\n'))
    expect(r.out.trim()).toBe('1')
  })
})

async function runCli(
  cmdline: string,
  stdin: string | null = null,
  files: Record<string, string> = {},
): Promise<{ out: string; err: string; exitCode: number }> {
  const resource = new RAMResource()
  for (const [path, text] of Object.entries(files)) resource.store.files.set(path, ENC.encode(text))
  const parsed = parseCommand(specOf('jq'), cmdline.split(' ').slice(1), '/')
  const cmd = RAM_JQ[0]
  if (cmd === undefined) throw new Error('jq not registered')
  const result = await cmd.fn(
    (resource as { accessor?: unknown }).accessor as never,
    parsed.paths().map((p) => PathSpec.fromStrPath(p)),
    parsed.texts(),
    {
      stdin: stdin === null ? null : ENC.encode(stdin),
      flags: parseToKwargs(parsed),
      filetypeFns: null,
      cwd: '/',
      resource,
    },
  )
  if (result === null) throw new Error('no result')
  const [out, io] = result
  const buf = out === null ? new Uint8Array() : await materialize(out as AsyncIterable<Uint8Array>)
  const err = io.stderr instanceof Uint8Array ? DEC.decode(io.stderr) : ''
  return { out: DEC.decode(buf), err, exitCode: io.exitCode }
}

describe('jq command — real jq semantics', () => {
  it.each([
    ['-e', '-e .b'],
    ['-j', '-j .a'],
    ['-S', '-S .'],
    ['-R', '-R .'],
    ['--tab', '--tab .'],
    ['--indent', '--indent 1 .'],
    ['--seq', '--seq .'],
    ['-a', '-a .'],
    ['-M', '-M .a'],
  ])('accepts %s instead of reading the filter as a file', async (_flag, args) => {
    const r = await runCli(`jq ${args}`, '{"a":1}')
    expect(r.err).not.toMatch(/no mount|file not found|Could not open/)
  })

  it('prints each output on its own line, honoring -r', async () => {
    const r = await runCli('jq -r .a,.b', '{"a":"x","b":"y"}')
    expect(r.out).toBe('x\ny\n')
  })

  it('does not fold generator output into an array', async () => {
    const r = await runCli('jq -n -c range(3)')
    expect(r.out).toBe('0\n1\n2\n')
  })

  it('treats piped NDJSON as a stream of values', async () => {
    const r = await runCli('jq .a', '{"a":1}\n{"a":2}\n')
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe('1\n2\n')
  })

  it('slurps piped NDJSON with -s', async () => {
    const r = await runCli('jq -c -s .', '{"a":1}\n{"a":2}\n')
    expect(r.out).toBe('[{"a":1},{"a":2}]\n')
  })

  it('returns jq exit status for -e', async () => {
    expect((await runCli('jq -e .b', '{"a":1}')).exitCode).toBe(1)
    expect((await runCli('jq -e .a', '{"a":1}')).exitCode).toBe(0)
  })

  it('reports jq errors once, with jq exit codes', async () => {
    const r = await runCli('jq .a.b', '{"a":1}')
    expect(r.exitCode).toBe(5)
    expect(r.err).toMatch(/^jq: error/)
    expect(r.err).not.toMatch(/jq: jq:/)
  })

  it('keeps a .jsonl file operand as one array of records', async () => {
    const files = { '/d.jsonl': '{"a":1}\n{"a":2}\n' }
    expect((await runCli('jq length /d.jsonl', null, files)).out).toBe('2\n')
    expect((await runCli('jq .[].a /d.jsonl', null, files)).out).toBe('1\n2\n')
  })

  it('concatenates outputs across file operands', async () => {
    const files = { '/a.json': '{"v":1}', '/b.json': '{"v":2}' }
    expect((await runCli('jq .v /a.json /b.json', null, files)).out).toBe('1\n2\n')
  })

  it('binds --slurpfile as an array of the file values', async () => {
    const files = { '/v.json': '1 2 3' }
    const r = await runCli('jq -n -c --slurpfile xs /v.json $xs', null, files)
    expect(r.out).toBe('[1,2,3]\n')
  })

  it('reads the filter from -f and treats the operand as input', async () => {
    const files = { '/f.jq': '.a', '/in.json': '{"a":9}' }
    expect((await runCli('jq -f /f.jq /in.json', null, files)).out).toBe('9\n')
  })

  it('rejects --args with a pointer to --arg', async () => {
    const r = await runCli('jq -n --args $ARGS a')
    expect(r.exitCode).toBe(2)
    expect(r.err).toMatch(/--arg name value/)
  })
})
