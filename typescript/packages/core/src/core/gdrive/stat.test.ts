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
import { GDriveAccessor } from '../../accessor/gdrive.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { FileType, PathSpec } from '../../types.ts'
import { TokenManager } from '../google/_client.ts'
import { stat } from './stat.ts'

function makeAccessor(): GDriveAccessor {
  const tm = new TokenManager({
    clientId: 'id',
    refreshToken: 'rt',
    refreshFn: () => Promise.resolve({ accessToken: 'tok', expiresIn: 3600 }),
  })
  return new GDriveAccessor({ tokenManager: tm })
}

function fetchReturning(body: object): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response) as unknown as typeof fetch
}

function missPath(name: string): PathSpec {
  return new PathSpec({ original: `/${name}`, directory: '/' })
}

describe('gdrive stat — fast negative lookup', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('issues a single targeted files.list (name= + parent=) and returns ENOENT fast, never walking the parent', async () => {
    const fakeFetch = fetchReturning({ files: [] })
    globalThis.fetch = fakeFetch
    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()

    await expect(stat(accessor, missPath('nope.txt'), index)).rejects.toThrow(/ENOENT/)

    // Exactly one request — the targeted lookup. A full parent listing would
    // have paginated the whole folder (the /sessions stall).
    expect(fakeFetch).toHaveBeenCalledTimes(1)
    const rawUrl = (fakeFetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]
    const url = new URL(String(rawUrl))
    const q = url.searchParams.get('q') ?? ''
    expect(q).toContain("'root' in parents")
    expect(q).toContain("name='nope.txt'")
    expect(url.pathname).toMatch(/\/drive\/v3\/files$/)
  })

  it('promotes a hit from the targeted query into the index and stats it', async () => {
    const fakeFetch = fetchReturning({
      files: [
        {
          id: 'file1',
          name: 'found.txt',
          mimeType: 'text/plain',
          size: '12',
          modifiedTime: '2026-04-01T00:00:00.000Z',
        },
      ],
    })
    globalThis.fetch = fakeFetch
    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()

    const st = await stat(accessor, missPath('found.txt'), index)
    expect(st.name).toBe('found.txt')
    expect(st.type).toBe(FileType.TEXT)
    expect(fakeFetch).toHaveBeenCalledTimes(1)

    // Second stat is a pure cache hit — no further network.
    const again = await stat(accessor, missPath('found.txt'), index)
    expect(again.name).toBe('found.txt')
    expect(fakeFetch).toHaveBeenCalledTimes(1)
  })

  it('a warm cached path stats without any network (valid-path perf unchanged)', async () => {
    const fakeFetch = fetchReturning({ files: [] })
    globalThis.fetch = fakeFetch
    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    await index.put(
      '/warm.txt',
      new IndexEntry({
        id: 'w1',
        name: 'warm.txt',
        resourceType: 'gdrive/file',
        vfsName: 'warm.txt',
        size: 3,
      }),
    )

    const st = await stat(accessor, missPath('warm.txt'), index)
    expect(st.name).toBe('warm.txt')
    expect(fakeFetch).not.toHaveBeenCalled()
  })
})
