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

import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../core/s3/read.ts', () => ({ read: vi.fn() }))
vi.mock('../../../core/s3/glob.ts', () => ({
  resolveGlob: vi.fn((_accessor: unknown, paths: unknown) => Promise.resolve(paths)),
}))
vi.mock('../../../core/s3/write.ts', () => ({ write: vi.fn(() => Promise.resolve()) }))
vi.mock('../../../core/s3/mkdir.ts', () => ({ mkdir: vi.fn(() => Promise.resolve()) }))

import type { S3Accessor } from '../../../accessor/s3.ts'
import type { Resource } from '../../../resource/base.ts'
import { read as s3Read } from '../../../core/s3/read.ts'
import { write as s3Write } from '../../../core/s3/write.ts'
import { PathSpec } from '../../../types.ts'
import { deflateRaw } from '../../../utils/compress.ts'
import { UNZIP_MAX_UNCOMPRESSED_BYTES } from '../utils/unzip_limit.ts'
import { S3_UNZIP } from './unzip.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const ACCESSOR = {} as S3Accessor

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

async function run(archive: Uint8Array, flags: Record<string, string | boolean>) {
  vi.mocked(s3Read).mockResolvedValue(archive)
  const cmd = S3_UNZIP[0]
  if (cmd === undefined) throw new Error('not registered')
  const result = await cmd.fn(ACCESSOR, [PathSpec.fromStrPath('/big.zip')], [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: { kind: 's3' } as unknown as Resource,
  })
  const output = result?.[0]
  return output instanceof Uint8Array ? DEC.decode(output) : ''
}

describe('unzip size guard (S3)', () => {
  it('refuses before inflating when the headers declare more than the limit', async () => {
    vi.mocked(s3Write).mockClear()
    const archive = zipMember('huge.bin', ENC.encode('tiny'), 0, UNZIP_MAX_UNCOMPRESSED_BYTES + 1)
    await expect(run(archive, { d: '/' })).rejects.toThrow(
      /^unzip: \/big\.zip exceeds the 16 MB in-Brain extract limit/,
    )
    expect(s3Write).not.toHaveBeenCalled()
  })

  it('still lists (-l) an oversized archive from its headers alone', async () => {
    const declared = UNZIP_MAX_UNCOMPRESSED_BYTES + 1
    const out = await run(zipMember('huge.bin', ENC.encode('tiny'), 0, declared), { args_l: true })
    expect(out).toContain(`${String(declared)}  huge.bin`)
  })

  it('caps the inflated bytes when the headers understate the size', async () => {
    vi.mocked(s3Write).mockClear()
    const body = await deflateRaw(new Uint8Array(UNZIP_MAX_UNCOMPRESSED_BYTES + 1))
    await expect(run(zipMember('zeros.bin', body, 8, 0), { d: '/' })).rejects.toThrow(
      /^unzip: archive exceeds the 16 MB in-Brain extract limit/,
    )
    expect(s3Write).not.toHaveBeenCalled()
  })
})
