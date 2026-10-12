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
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { FileStat, FileType, MountMode, type PathSpec } from '../types.ts'
import type { BridgeDispatchFn } from './executor/python/mirage_bridge.ts'
import { Workspace } from './workspace.ts'

const ENC = new TextEncoder()

/** RAM resource with a bounded read, as a store that supports ranges would have. */
class RangeRAMResource extends RAMResource {
  readonly rangeCalls: [string, number, number][] = []
  rangeResult: ((bytes: Uint8Array) => Uint8Array) | null = null

  readRange(path: PathSpec, offset: number, length: number): Promise<Uint8Array> {
    const key = path.original.slice(path.prefix.replace(/\/+$/, '').length)
    this.rangeCalls.push([key, offset, length])
    const bytes = this.store.files.get(key) ?? new Uint8Array()
    const out = bytes.slice(offset, offset + length)
    return Promise.resolve(this.rangeResult === null ? out : this.rangeResult(out))
  }
}

function setup(resource: RAMResource = new RangeRAMResource()) {
  const ops = new OpsRegistry()
  for (const op of resource.ops()) ops.register(op)
  const ws = new Workspace({ '/data': resource }, { mode: MountMode.WRITE, ops })
  const bridge = (
    ws as unknown as { buildWorkspaceBridge(enforce: boolean): BridgeDispatchFn }
  ).buildWorkspaceBridge(true)
  return { ws, bridge }
}

function range(value: unknown): Uint8Array {
  return ENC.encode(JSON.stringify(value))
}

describe('bridge READ_RANGE', () => {
  it('returns the requested slice through Resource.readRange', async () => {
    const resource = new RangeRAMResource()
    resource.store.files.set('/big.bin', new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))
    const { bridge } = setup(resource)
    expect(await bridge('READ_RANGE', '/data/big.bin', range([2, 3]))).toEqual(
      new Uint8Array([2, 3, 4]),
    )
    expect(resource.rangeCalls).toEqual([['/big.bin', 2, 3]])
  })

  it('supports zero-length reads and a short read at EOF', async () => {
    const resource = new RangeRAMResource()
    resource.store.files.set('/big.bin', new Uint8Array([9, 8, 7]))
    const { bridge } = setup(resource)
    expect(await bridge('READ_RANGE', '/data/big.bin', range([0, 0]))).toEqual(new Uint8Array())
    expect(await bridge('READ_RANGE', '/data/big.bin', range([1, 100]))).toEqual(
      new Uint8Array([8, 7]),
    )
  })

  it.each([
    ['negative offset', range([-1, 1])],
    ['length over 64 KiB', range([0, 65537])],
    ['negative length', range([0, -1])],
    ['fractional offset', range([1.2, 1])],
    ['NaN length (JSON null)', range([0, NaN])],
    ['offset at MAX_SAFE_INTEGER', range([Number.MAX_SAFE_INTEGER, 1])],
    ['string offset', range(['0', 1])],
    ['wrong arity', range([0])],
    ['malformed JSON', ENC.encode('[0,')],
    ['no payload', undefined],
  ])('rejects %s with EINVAL before touching storage', async (_name, bytes) => {
    const resource = new RangeRAMResource()
    resource.store.files.set('/big.bin', new Uint8Array(10))
    const { bridge } = setup(resource)
    await expect(bridge('READ_RANGE', '/data/big.bin', bytes)).rejects.toMatchObject({
      code: 'EINVAL',
    })
    expect(resource.rangeCalls).toEqual([])
  })

  it('refuses a resource without readRange (ENOTSUP), with no whole-file fallback', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/big.bin', new Uint8Array(10))
    const { ws, bridge } = setup(resource)
    const readFile = vi.spyOn(ws.fs, 'readFile')
    await expect(bridge('READ_RANGE', '/data/big.bin', range([0, 1]))).rejects.toMatchObject({
      code: 'ENOTSUP',
    })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('rejects a resource response longer than the requested length (EIO)', async () => {
    const resource = new RangeRAMResource()
    resource.store.files.set('/big.bin', new Uint8Array(10))
    resource.rangeResult = () => new Uint8Array(5)
    const { bridge } = setup(resource)
    await expect(bridge('READ_RANGE', '/data/big.bin', range([0, 2]))).rejects.toMatchObject({
      code: 'EIO',
    })
  })
})

describe('bridge LIST', () => {
  it('skips an entry that vanished between the listing and its stat', async () => {
    const { ws, bridge } = setup()
    await ws.fs.writeFile('/data/keep.txt', 'k')
    await ws.fs.writeFile('/data/gone.txt', 'g')
    const realStat = ws.fs.stat.bind(ws.fs)
    vi.spyOn(ws.fs, 'stat').mockImplementation((p: string) => {
      if (p === '/data/gone.txt') {
        return Promise.reject(Object.assign(new Error('ENOENT: gone.txt'), { code: 'ENOENT' }))
      }
      return realStat(p)
    })
    expect(await bridge('LIST', '/data')).toEqual([
      { path: '/data/keep.txt', size: 1, isDir: false },
    ])
  })

  it('also recognises an ENOENT that is only in the message', async () => {
    const { ws, bridge } = setup()
    await ws.fs.writeFile('/data/gone.txt', 'g')
    vi.spyOn(ws.fs, 'stat').mockRejectedValue(new Error('ENOENT: gone.txt'))
    expect(await bridge('LIST', '/data')).toEqual([])
  })

  it('still fails the listing on any other stat error', async () => {
    const { ws, bridge } = setup()
    await ws.fs.writeFile('/data/a.txt', 'a')
    vi.spyOn(ws.fs, 'stat').mockRejectedValue(
      Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }),
    )
    await expect(bridge('LIST', '/data')).rejects.toThrow('EACCES')
  })

  it('lists directories with size 0', async () => {
    const { ws, bridge } = setup()
    await ws.fs.mkdir('/data/sub')
    vi.spyOn(ws.fs, 'stat').mockResolvedValue(
      new FileStat({ name: 'sub', type: FileType.DIRECTORY, size: 4096 }),
    )
    expect(await bridge('LIST', '/data')).toEqual([{ path: '/data/sub', size: 0, isDir: true }])
  })
})
