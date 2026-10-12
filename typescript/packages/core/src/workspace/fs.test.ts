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
import { RAMIndexCacheStore } from '../cache/index/ram.ts'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import type { Resource } from '../resource/base.ts'
import { MountMode, PathSpec } from '../types.ts'
import { WorkspaceFS } from './fs.ts'
import { Workspace } from './workspace.ts'

function mkWorkspace(): Workspace {
  const resource = new RAMResource()
  const ops = new OpsRegistry()
  for (const op of resource.ops()) ops.register(op)
  return new Workspace({ '/data': resource }, { mode: MountMode.WRITE, ops })
}

describe('WorkspaceFS', () => {
  it('writeFile + readFile round-trips bytes', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/a.txt', 'hello')
    const text = await ws.fs.readFileText('/data/a.txt')
    expect(text).toBe('hello')
  })

  it('writeFile accepts Uint8Array', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/b.bin', new Uint8Array([1, 2, 3]))
    const bytes = await ws.fs.readFile('/data/b.bin')
    expect([...bytes]).toEqual([1, 2, 3])
  })

  it('mkdir + readdir lists entries', async () => {
    const ws = mkWorkspace()
    await ws.fs.mkdir('/data/sub')
    await ws.fs.writeFile('/data/sub/x.txt', 'x')
    await ws.fs.writeFile('/data/sub/y.txt', 'y')
    const entries = await ws.fs.readdir('/data/sub')
    expect(entries.sort()).toEqual(['/data/sub/x.txt', '/data/sub/y.txt'])
  })

  it('exists returns true for existing files and dirs', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/hi.txt', 'hi')
    await ws.fs.mkdir('/data/dir')
    expect(await ws.fs.exists('/data/hi.txt')).toBe(true)
    expect(await ws.fs.exists('/data/dir')).toBe(true)
    expect(await ws.fs.exists('/data/nope')).toBe(false)
  })

  it('isDir distinguishes files from directories', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/file.txt', 'x')
    await ws.fs.mkdir('/data/dir')
    expect(await ws.fs.isDir('/data/dir')).toBe(true)
    expect(await ws.fs.isDir('/data/file.txt')).toBe(false)
    expect(await ws.fs.isFile('/data/file.txt')).toBe(true)
    expect(await ws.fs.isFile('/data/dir')).toBe(false)
  })

  it('stat returns size', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/a.txt', 'hello')
    const s = await ws.fs.stat('/data/a.txt')
    expect(s.size).toBe(5)
  })

  it('unlink removes file', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/gone.txt', 'x')
    expect(await ws.fs.exists('/data/gone.txt')).toBe(true)
    await ws.fs.unlink('/data/gone.txt')
    expect(await ws.fs.exists('/data/gone.txt')).toBe(false)
  })

  it('cat reads file as string', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/t.txt', 'content')
    expect(await ws.fs.cat('/data/t.txt')).toBe('content')
  })
})

describe('WorkspaceFS mutations pass the mount index', () => {
  // Ops are keyed by resource kind, so with several mounts of one kind (e.g.
  // two gdrive mounts) only the index kwarg tells the op which mount's caches
  // to invalidate. mkdir/unlink/rmdir/rename must pass it like writeFile does.
  function setup(index: RAMIndexCacheStore | undefined) {
    const resource = { kind: 'gdrive', index } as unknown as Resource
    const spec = PathSpec.fromStrPath('/g/x')
    const call = vi.fn(() => Promise.resolve(undefined))
    const ops = { call } as unknown as OpsRegistry
    const fs = new WorkspaceFS(() => Promise.resolve([resource, spec, MountMode.WRITE]), ops)
    return { fs, call, spec }
  }

  it.each(['mkdir', 'unlink', 'rmdir'] as const)('%s passes { index }', async (op) => {
    const index = new RAMIndexCacheStore()
    const { fs, call, spec } = setup(index)
    await fs[op]('/g/x')
    expect(call).toHaveBeenCalledWith(op, 'gdrive', expect.anything(), spec, [], { index })
  })

  it('rename passes { index } after the destination', async () => {
    const index = new RAMIndexCacheStore()
    const { fs, call, spec } = setup(index)
    await fs.rename('/g/x', '/g/y')
    expect(call).toHaveBeenCalledWith('rename', 'gdrive', expect.anything(), spec, [spec], {
      index,
    })
  })

  it('passes empty kwargs when the resource has no index', async () => {
    const { fs, call, spec } = setup(undefined)
    await fs.mkdir('/g/x')
    expect(call).toHaveBeenCalledWith('mkdir', 'gdrive', expect.anything(), spec, [], {})
  })
})
