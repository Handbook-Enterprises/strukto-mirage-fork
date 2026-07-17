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
import type * as ClientModule from '../google/_client.ts'

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  return { ...actual, listAllFiles: vi.fn() }
})

vi.mock('../google/_client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('../google/_client.ts')
  return { ...actual, googleGet: vi.fn() }
})

import { GSheetsAccessor } from '../../accessor/gsheets.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import type { TokenManager } from '../google/_client.ts'
import * as drive from '../google/drive.ts'
import * as client from '../google/_client.ts'
import {
  fetchSheetTabs,
  parseSpreadsheetId,
  quoteSheetTitle,
  read,
  readValues,
  valuesToCsv,
} from './read.ts'

const STUB_TOKEN_MANAGER = {} as TokenManager

function makeAccessor(): GSheetsAccessor {
  return new GSheetsAccessor({ tokenManager: STUB_TOKEN_MANAGER })
}

describe('gsheets read auto-bootstrap', () => {
  it('refetches owned listing when entry is evicted from index', async () => {
    vi.mocked(drive.listAllFiles).mockResolvedValue([
      {
        id: 'sheet1',
        name: 'Budget',
        modifiedTime: '2026-04-01T00:00:00.000Z',
        owners: [{ me: true }],
      },
    ])
    vi.mocked(client.googleGet).mockResolvedValue({ spreadsheetId: 'sheet1' })

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const path = new PathSpec({
      original: '/gsheets/owned/2026-04-01_Budget__sheet1.gsheet.json',
      directory: '/gsheets/owned/2026-04-01_Budget__sheet1.gsheet.json',
      prefix: '/gsheets',
    })
    const out = await read(accessor, path, index)
    expect(new TextDecoder().decode(out)).toContain('sheet1')
  })

  it('throws ENOENT when file missing even after recursion', async () => {
    vi.mocked(drive.listAllFiles).mockResolvedValue([])
    vi.mocked(client.googleGet).mockRejectedValue(new Error('should not call googleGet'))

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const path = new PathSpec({
      original: '/gsheets/owned/Missing__xyz.gsheet.json',
      directory: '/gsheets/owned/Missing__xyz.gsheet.json',
      prefix: '/gsheets',
    })
    await expect(read(accessor, path, index)).rejects.toThrow(/ENOENT/)
  })
})

describe('gsheets exact-ID read helpers', () => {
  it('parses bare IDs and Google Sheets share URLs', () => {
    expect(parseSpreadsheetId('sheet_123')).toBe('sheet_123')
    expect(parseSpreadsheetId('https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42')).toBe(
      'sheet_123',
    )
    expect(parseSpreadsheetId('not a sheet id')).toBeNull()
  })

  it('quotes tab titles for A1 ranges', () => {
    expect(quoteSheetTitle('Sheet1')).toBe('Sheet1')
    expect(quoteSheetTitle("Owner's Scorecard")).toBe("'Owner''s Scorecard'")
  })

  it('formats values as valid CSV', () => {
    expect(valuesToCsv([['a', 'b'], ['1', 'two, three'], ['say "hi"']])).toBe(
      'a,b\n1,"two, three"\n"say ""hi"""',
    )
  })

  it('returns sorted tab metadata', async () => {
    vi.mocked(client.googleGet).mockResolvedValue({
      sheets: [
        { properties: { title: 'Second', sheetId: 22, index: 1 } },
        { properties: { title: 'First', sheetId: 11, index: 0 } },
      ],
    })
    await expect(fetchSheetTabs(STUB_TOKEN_MANAGER, 'sheet1')).resolves.toEqual([
      { title: 'First', sheetId: 11, index: 0 },
      { title: 'Second', sheetId: 22, index: 1 },
    ])
  })

  it('URL-encodes A1 ranges while preserving JSON output', async () => {
    vi.mocked(client.googleGet).mockResolvedValue({ values: [['ok']] })
    const out = await readValues(STUB_TOKEN_MANAGER, 'sheet1', "'Outlet Scorecard'!A1:B2")
    expect(new TextDecoder().decode(out)).toBe('{"values":[["ok"]]}')
    expect(vi.mocked(client.googleGet).mock.calls.at(-1)?.[1]).toContain(
      "'Outlet%20Scorecard'!A1%3AB2",
    )
  })
})
