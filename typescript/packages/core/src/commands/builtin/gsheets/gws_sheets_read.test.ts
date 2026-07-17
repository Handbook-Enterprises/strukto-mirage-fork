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
import type { GoogleApiAccessor } from '../../../accessor/google_api.ts'
import type { CommandOpts } from '../../config.ts'
import { ResourceName } from '../../../types.ts'
import type { TokenManager } from '../../../core/google/_client.ts'
import { GSHEETS_GWS_READ, GSHEETS_GWS_READ_ALIAS } from './gws_sheets_read.ts'
import { GSHEETS_GWS_APPEND } from './gws_sheets_append.ts'
import { GSHEETS_GWS_BATCH_UPDATE } from './gws_sheets_spreadsheets_batchUpdate.ts'
import { GSHEETS_GWS_CREATE } from './gws_sheets_spreadsheets_create.ts'
import { GSHEETS_GWS_WRITE } from './gws_sheets_write.ts'
import { GDOCS_GWS_BATCH_UPDATE } from '../gdocs/gws_docs_documents_batchUpdate.ts'
import { GSLIDES_GWS_BATCH_UPDATE } from '../gslides/gws_slides_presentations_batchUpdate.ts'
import { GSHEETS_COMMANDS } from './index.ts'
import { GDRIVE_COMMANDS } from '../gdrive/index.ts'

const DEC = new TextDecoder()
const ID = 'spreadsheet_1234567890'
const tokenManager = { getToken: () => Promise.resolve('token') } as unknown as TokenManager
const accessor = { tokenManager } as GoogleApiAccessor
const command = GSHEETS_GWS_READ.find((candidate) => candidate.resource === ResourceName.GSHEETS)

function backend(): ReturnType<typeof vi.fn> {
  return vi.fn((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/values/')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            values: [
              ['a', 'b'],
              ['1', 'two, three'],
            ],
          }),
        ),
      )
    }
    if (url.includes('sheets.properties')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            sheets: [
              { properties: { title: 'Cover', sheetId: 0, index: 0 } },
              { properties: { title: 'Outlet Scorecard', sheetId: 42, index: 1 } },
            ],
          }),
        ),
      )
    }
    if (url.includes('/export?')) return Promise.resolve(new Response('fallback,csv\n'))
    return Promise.resolve(new Response(`unexpected URL: ${url}`, { status: 500 }))
  })
}

async function run(flags: Record<string, string | boolean>, texts: string[] = []) {
  if (command === undefined) throw new Error('missing GSHEETS command')
  return command.fn(accessor, [], texts, {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: {} as never,
  } as CommandOpts)
}

describe('gws-sheets-read', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('registers one strict read command for Sheets and Drive', () => {
    expect(GSHEETS_GWS_READ.map((candidate) => candidate.resource)).toEqual([
      ResourceName.GSHEETS,
      ResourceName.GDRIVE,
    ])
    expect(GSHEETS_GWS_READ.every((candidate) => !candidate.write)).toBe(true)
    expect(GSHEETS_GWS_READ.every((candidate) => candidate.mountRouting === 'cwd-or-unique')).toBe(
      true,
    )
    expect(GSHEETS_GWS_READ_ALIAS.map((candidate) => candidate.resource)).toEqual([
      ResourceName.GSHEETS,
      ResourceName.GDRIVE,
    ])
    expect(GSHEETS_GWS_READ_ALIAS.every((candidate) => candidate.name === 'gws-sheet-read')).toBe(
      true,
    )
  })

  it('exports exactly one resource-correct variant per resource catalog', () => {
    const sheets = GSHEETS_COMMANDS.filter((candidate) => candidate.name === 'gws-sheets-read')
    const drive = GDRIVE_COMMANDS.filter((candidate) => candidate.name === 'gws-sheets-read')
    expect(sheets).toHaveLength(1)
    expect(sheets[0]?.resource).toBe(ResourceName.GSHEETS)
    expect(drive).toHaveLength(1)
    expect(drive[0]?.resource).toBe(ResourceName.GDRIVE)
  })

  it('marks every adjacent Google mutation as a write command', () => {
    const mutations = [
      ...GSHEETS_GWS_APPEND,
      ...GSHEETS_GWS_BATCH_UPDATE,
      ...GSHEETS_GWS_CREATE,
      ...GSHEETS_GWS_WRITE,
      ...GDOCS_GWS_BATCH_UPDATE,
      ...GSLIDES_GWS_BATCH_UPDATE,
    ]
    expect(mutations.length).toBeGreaterThan(0)
    expect(mutations.every((candidate) => candidate.write)).toBe(true)
  })

  it('preserves legacy JSON output for --spreadsheet plus --range', async () => {
    vi.stubGlobal('fetch', backend())
    const result = await run({ spreadsheet: ID, range: 'Cover!A1:B2' })
    expect(DEC.decode(result?.[0] as Uint8Array)).toBe('{"values":[["a","b"],["1","two, three"]]}')
  })

  it('accepts a share URL through --id and lists tabs', async () => {
    vi.stubGlobal('fetch', backend())
    const result = await run({
      id: `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=42`,
      list: true,
    })
    expect(DEC.decode(result?.[0] as Uint8Array)).toBe('0\tCover\n42\tOutlet Scorecard\n')
  })

  it('accepts a share URL as a positional compatibility form', async () => {
    vi.stubGlobal('fetch', backend())
    const result = await run({ list: true }, [
      `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=42`,
    ])
    expect(DEC.decode(result?.[0] as Uint8Array)).toContain('42\tOutlet Scorecard')
  })

  it('reads a named tab as CSV for the agent-friendly --id form', async () => {
    vi.stubGlobal('fetch', backend())
    const result = await run({ id: ID, tab: 'Outlet Scorecard' })
    expect(DEC.decode(result?.[0] as Uint8Array)).toBe('a,b\n1,"two, three"')
  })

  it('resolves a gid to its tab title', async () => {
    const fetchMock = backend()
    vi.stubGlobal('fetch', fetchMock)
    await run({ id: ID, gid: '42' })
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('Outlet%20Scorecard'))).toBe(
      true,
    )
  })

  it('lists tabs by default instead of silently returning the first of many', async () => {
    vi.stubGlobal('fetch', backend())
    const result = await run({ id: ID })
    expect(DEC.decode(result?.[0] as Uint8Array)).toContain('42\tOutlet Scorecard')
    expect(DEC.decode(result?.[1].stderr as Uint8Array)).toContain('2 tabs')
  })

  it('rejects conflicting selectors', async () => {
    const result = await run({ id: ID, list: true, tab: 'Cover' })
    expect(result?.[1].exitCode).toBe(2)
    expect(DEC.decode(result?.[1].stderr as Uint8Array)).toContain('only one')
  })

  it('ships discoverable help for every new option', async () => {
    const result = await run({ help: true })
    const help = DEC.decode(result?.[0] as Uint8Array)
    expect(help).toContain('gws-sheets-read: Read Google Sheet values')
    expect(help).toContain('--mount')
    expect(help).toContain('--list')
    expect(help).toContain('--format')
  })
})
