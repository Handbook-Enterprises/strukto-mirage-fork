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

import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './_client.ts'

vi.mock('./_client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./_client.ts')
  return { ...actual, googleGet: vi.fn() }
})

import type { TokenManager } from './_client.ts'
import * as client from './_client.ts'
import { LIST_FILES_BUDGET_MS, findFileInFolder, listFiles } from './drive.ts'

const STUB_TM = {} as TokenManager

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(client.googleGet).mockReset()
})

describe('listFiles pagination budget', () => {
  it('throws a diagnostic naming the folder + pages when a never-ending listing blows the budget', async () => {
    // Every page hands back another nextPageToken → the old for(;;) would loop
    // forever. The mocked clock makes elapsed exceed the budget after page 1.
    vi.mocked(client.googleGet).mockResolvedValue({
      files: [{ id: 'f', name: 'x', mimeType: 'text/plain' }],
      nextPageToken: 'more',
    })
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValue(1_000 + LIST_FILES_BUDGET_MS + 5_000)

    await expect(listFiles(STUB_TM, { folderId: 'folderXYZ' })).rejects.toThrow(
      /pagination budget.*folderXYZ.*page/s,
    )
    // Budget tripped right after the first page — not an unbounded walk.
    expect(vi.mocked(client.googleGet)).toHaveBeenCalledTimes(1)
  })

  it('returns normally when pagination terminates within budget', async () => {
    vi.mocked(client.googleGet)
      .mockResolvedValueOnce({
        files: [{ id: 'a', name: 'one', mimeType: 'text/plain' }],
        nextPageToken: 'p2',
      })
      .mockResolvedValueOnce({ files: [{ id: 'b', name: 'two', mimeType: 'text/plain' }] })

    const out = await listFiles(STUB_TM, { folderId: 'root' })
    expect(out.map((f) => f.id)).toEqual(['a', 'b'])
  })
})

describe('findFileInFolder targeted lookup', () => {
  it('issues one files.list scoped to name AND parent (no pagination loop)', async () => {
    vi.mocked(client.googleGet).mockResolvedValue({ files: [] })

    await findFileInFolder(STUB_TM, 'folder123', 'report.txt')

    expect(vi.mocked(client.googleGet)).toHaveBeenCalledTimes(1)
    const [, , params] = vi.mocked(client.googleGet).mock.calls[0] as [
      unknown,
      string,
      Record<string, string | number>,
    ]
    expect(params.q).toContain("'folder123' in parents")
    expect(params.q).toContain("name='report.txt'")
    expect(params.q).toContain('trashed=false')
  })

  it("OR's multiple candidate names (workspace synthetic extension case)", async () => {
    vi.mocked(client.googleGet).mockResolvedValue({ files: [] })

    await findFileInFolder(STUB_TM, 'folder123', ['Report.gdoc.json', 'Report'])

    const [, , params] = vi.mocked(client.googleGet).mock.calls[0] as [
      unknown,
      string,
      Record<string, string | number>,
    ]
    expect(params.q).toContain("(name='Report.gdoc.json' or name='Report')")
  })
})
