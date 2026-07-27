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
    expect(r.exitCode).toBe(1)
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
