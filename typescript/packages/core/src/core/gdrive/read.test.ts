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
import type * as DriveModule from '../google/drive.ts'

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  return {
    ...actual,
    listFiles: vi.fn(),
    downloadFile: vi.fn(),
    findFileInFolder: vi.fn(() => Promise.resolve([])),
  }
})

import { GDriveAccessor } from '../../accessor/gdrive.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import type { TokenManager } from '../google/_client.ts'
import * as drive from '../google/drive.ts'
import { read } from './read.ts'

const STUB_TOKEN_MANAGER = {} as TokenManager

function makeAccessor(): GDriveAccessor {
  return new GDriveAccessor({ tokenManager: STUB_TOKEN_MANAGER })
}

describe('gdrive read auto-bootstrap', () => {
  it('refetches root listing when entry is evicted from index', async () => {
    vi.mocked(drive.listFiles).mockImplementation((_tm, opts) => {
      if (opts?.folderId === 'root') {
        return Promise.resolve([
          {
            id: 'f1',
            name: 'report.pdf',
            mimeType: 'application/pdf',
            modifiedTime: '2026-04-01T00:00:00.000Z',
          },
        ])
      }
      throw new Error(`unexpected folderId=${String(opts?.folderId)}`)
    })
    vi.mocked(drive.downloadFile).mockResolvedValue(new TextEncoder().encode('pdf-bytes'))

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const path = new PathSpec({ original: '/report.pdf', directory: '/report.pdf' })
    const out = await read(accessor, path, index)
    expect(new TextDecoder().decode(out)).toBe('pdf-bytes')
  })

  it('throws ENOENT when file missing even after recursion', async () => {
    vi.mocked(drive.listFiles).mockImplementation((_tm, opts) => {
      if (opts?.folderId === 'root') {
        return Promise.resolve([
          {
            id: 'f1',
            name: 'other.txt',
            mimeType: 'text/plain',
            modifiedTime: '2026-04-01T00:00:00.000Z',
          },
        ])
      }
      throw new Error(`unexpected folderId=${String(opts?.folderId)}`)
    })
    vi.mocked(drive.downloadFile).mockRejectedValue(new Error('should not call downloadFile'))

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const path = new PathSpec({ original: '/missing.txt', directory: '/missing.txt' })
    await expect(read(accessor, path, index)).rejects.toThrow(/ENOENT/)
  })

  // BLU-1451: `cp`/`mv` dispatch `read` on the source. A source that exists
  // live on Drive but is absent from a cold/stale index (or whose parent
  // listing is still eventually consistent) must still resolve, matching
  // `stat`'s targeted live lookup. Simulate the stale index: the entry is
  // absent from the index, the parent re-listing (listFiles) does NOT
  // surface it, but the targeted live files.list (findFileInFolder) does.
  it('resolves a source present live but absent from the index (stat/read parity)', async () => {
    // Parent re-listing is stale — it does not contain the file.
    vi.mocked(drive.listFiles).mockResolvedValue([])
    // Targeted live lookup (name= + parent=) finds it, exactly as stat does.
    vi.mocked(drive.findFileInFolder).mockResolvedValue([
      {
        id: 'live1',
        name: 'fresh.json',
        mimeType: 'application/json',
        modifiedTime: '2026-04-01T00:00:00.000Z',
      },
    ])
    vi.mocked(drive.downloadFile).mockResolvedValue(new TextEncoder().encode('{"ok":true}'))

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const path = new PathSpec({ original: '/fresh.json', directory: '/fresh.json' })
    const out = await read(accessor, path, index)
    // Without the targeted live lookup this read throws ENOENT (listFiles,
    // the parent re-listing, is empty), so a successful decode is proof the
    // live path resolved the source.
    expect(new TextDecoder().decode(out)).toBe('{"ok":true}')
    expect(drive.findFileInFolder).toHaveBeenCalled()
  })
})
