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
import { PathSpec } from '../../../types.ts'
import { RAM_AWK } from './awk.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runAwk(
  resource: RAMResource,
  program: string,
  paths: PathSpec[],
  flags: Record<string, string | boolean> = {},
): Promise<{ out: string; stderr: string; exitCode: number }> {
  const cmd = RAM_AWK[0]
  if (cmd === undefined) throw new Error('awk not registered')
  const result = await cmd.fn(
    (resource as { accessor?: unknown }).accessor as never,
    paths,
    [program],
    { stdin: null, flags, filetypeFns: null, cwd: '/', resource },
  )
  if (result === null) return { out: '', stderr: '', exitCode: -1 }
  const [out, io] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const stderr = io.stderr instanceof Uint8Array ? io.stderr : new Uint8Array()
  return { out: DEC.decode(buf), stderr: DEC.decode(stderr), exitCode: io.exitCode }
}

describe('awk — supported subset keeps working', () => {
  it('{print $2} prints the second field', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('a b\nc d\n'))
    const r = await runAwk(resource, '{print $2}', [PathSpec.fromStrPath('/tmp/f.txt')])
    expect(r.exitCode).toBe(0)
    expect(r.out.trim().split('\n')).toEqual(['b', 'd'])
  })

  it('{sum += $1} END {print sum} accumulates and prints the total', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/n.txt', ENC.encode('1\n2\n3\n'))
    const r = await runAwk(resource, '{sum += $1} END {print sum}', [
      PathSpec.fromStrPath('/tmp/n.txt'),
    ])
    expect(r.exitCode).toBe(0)
    expect(r.out.trim()).toBe('6')
  })
})

describe('awk — previously-silent miscompute now fails loudly', () => {
  it('arithmetic in an END print exits nonzero instead of emitting literal program text', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/report.tsv', ENC.encode('a\t10\t3\nb\t20\t5\n'))
    const program =
      '{rows+=1; clicks+=$2; weighted_position+=$3} END {print rows, clicks, weighted_position / impressions}'
    const r = await runAwk(resource, program, [PathSpec.fromStrPath('/tmp/report.tsv')], {
      F: '\t',
    })
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('awk: unsupported syntax:')
    expect(r.stderr).toContain('weighted_position / impressions')
    // The old behavior leaked the program text into stdout; assert it does not.
    expect(r.out).not.toContain('weighted_position')
  })
})
