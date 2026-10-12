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
import { deflateRaw } from '../../../utils/compress.ts'
import { UNZIP_MAX_UNCOMPRESSED_BYTES } from '../utils/unzip_limit.ts'
import { RAM_UNZIP } from './unzip.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

/** One local-file-header zip member; `declaredSize` is what the header claims. */
function zipMember(name: string, body: Uint8Array, method: 0 | 8, declaredSize: number) {
  const nameBytes = ENC.encode(name)
  const header = new Uint8Array(30 + nameBytes.byteLength)
  const view = new DataView(header.buffer)
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(8, method, true)
  view.setUint32(18, body.byteLength, true)
  view.setUint32(22, declaredSize, true)
  view.setUint16(26, nameBytes.byteLength, true)
  header.set(nameBytes, 30)
  const out = new Uint8Array(header.byteLength + body.byteLength)
  out.set(header, 0)
  out.set(body, header.byteLength)
  return out
}

async function run(resource: RAMResource, flags: Record<string, string | boolean>) {
  const cmd = RAM_UNZIP[0]
  if (cmd === undefined) throw new Error('not registered')
  const result = await cmd.fn(resource.accessor, [PathSpec.fromStrPath('/big.zip')], [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  const output = result?.[0] ?? null
  if (output === null) return ''
  return DEC.decode(
    output instanceof Uint8Array ? output : await materialize(output as AsyncIterable<Uint8Array>),
  )
}

describe('unzip size guard (RAM)', () => {
  it('refuses before inflating when the headers declare more than the limit', async () => {
    const resource = new RAMResource()
    const declared = UNZIP_MAX_UNCOMPRESSED_BYTES + 1
    resource.store.files.set('/big.zip', zipMember('huge.bin', ENC.encode('tiny'), 0, declared))
    await expect(run(resource, { d: '/' })).rejects.toThrow(
      /^unzip: \/big\.zip exceeds the 16 MB in-Brain extract limit.*\/transfer/,
    )
    expect(resource.store.files.has('/huge.bin')).toBe(false)
  })

  it('still lists (-l) an oversized archive from its headers alone', async () => {
    const resource = new RAMResource()
    const declared = UNZIP_MAX_UNCOMPRESSED_BYTES + 1
    resource.store.files.set('/big.zip', zipMember('huge.bin', ENC.encode('tiny'), 0, declared))
    const out = await run(resource, { args_l: true })
    expect(out).toContain(`${String(declared)}  huge.bin`)
  })

  it('caps the inflated bytes when the headers understate the size', async () => {
    // Data-descriptor zips write 0 in the local header, so the pre-check passes
    // and only the cumulative cap inside readZipEntries can stop the inflate.
    const resource = new RAMResource()
    const body = await deflateRaw(new Uint8Array(UNZIP_MAX_UNCOMPRESSED_BYTES + 1))
    resource.store.files.set('/big.zip', zipMember('zeros.bin', body, 8, 0))
    await expect(run(resource, { d: '/' })).rejects.toThrow(
      /^unzip: archive exceeds the 16 MB in-Brain extract limit/,
    )
    expect(resource.store.files.has('/zeros.bin')).toBe(false)
  })

  it('extracts an archive under the limit', async () => {
    const resource = new RAMResource()
    const data = ENC.encode('hello')
    resource.store.files.set('/big.zip', zipMember('a.txt', data, 0, data.byteLength))
    await run(resource, { d: '/' })
    expect(DEC.decode(resource.store.files.get('/a.txt'))).toBe('hello')
  })
})
