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

import type { GoogleApiAccessor } from '../../../accessor/google_api.ts'
import {
  exportFirstSheetCsv,
  fetchSheetTabs,
  parseSpreadsheetId,
  quoteSheetTitle,
  readValues,
  readValuesCsv,
  type SheetTab,
} from '../../../core/gsheets/read.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, Operand, OperandKind, Option } from '../../spec/types.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({
      long: '--spreadsheet',
      valueKind: OperandKind.TEXT,
      description: 'Spreadsheet ID or Google Sheets share URL',
    }),
    new Option({
      long: '--id',
      valueKind: OperandKind.TEXT,
      description: 'Alias for --spreadsheet',
    }),
    new Option({
      long: '--range',
      valueKind: OperandKind.TEXT,
      description: 'A1 range, such as Sheet1!A1:C10',
    }),
    new Option({
      long: '--tab',
      valueKind: OperandKind.TEXT,
      description: 'Read an entire tab by title',
    }),
    new Option({
      long: '--gid',
      valueKind: OperandKind.TEXT,
      description: 'Read a tab by its numeric gid',
    }),
    new Option({
      long: '--list',
      valueKind: OperandKind.NONE,
      description: 'List every tab as gid followed by title',
    }),
    new Option({
      long: '--format',
      valueKind: OperandKind.TEXT,
      description: 'Output values as json or csv',
    }),
    new Option({
      long: '--mount',
      valueKind: OperandKind.PATH,
      description: 'Route through an exact mounted provider, such as /gsheets',
    }),
  ],
  rest: new Operand({ kind: OperandKind.TEXT }),
  description:
    'Read Google Sheet values by ID or share URL. Lists tabs when a workbook is ambiguous.',
})

type OutputFormat = 'json' | 'csv'

function fail(message: string, exitCode = 2): CommandFnResult {
  return [null, new IOResult({ exitCode, stderr: ENC.encode(`${message}\n`) })]
}

function flagText(opts: CommandOpts, name: string): string {
  const value = opts.flags[name]
  return typeof value === 'string' ? value.trim() : ''
}

function resolveSpreadsheetId(
  opts: CommandOpts,
  texts: readonly string[],
): { id: string | null; usedIdAlias: boolean } {
  const spreadsheet = flagText(opts, 'spreadsheet')
  const idAlias = flagText(opts, 'id')
  if (spreadsheet !== '' && idAlias !== '') {
    const first = parseSpreadsheetId(spreadsheet)
    const second = parseSpreadsheetId(idAlias)
    if (first === null || second === null || first !== second) {
      return { id: null, usedIdAlias: true }
    }
  }
  const positional = texts.find((text) => !text.startsWith('-'))?.trim() ?? ''
  const usedIdAlias = idAlias !== '' || positional !== ''
  return { id: parseSpreadsheetId(idAlias || spreadsheet || positional), usedIdAlias }
}

function outputFormat(opts: CommandOpts, usedIdAlias: boolean): OutputFormat | null {
  const format = flagText(opts, 'format').toLowerCase()
  if (format === 'json' || format === 'csv') return format
  if (format !== '') return null
  return usedIdAlias ? 'csv' : 'json'
}

function formatTabList(tabs: readonly SheetTab[]): Uint8Array {
  const lines = tabs.map((tab) => `${String(tab.sheetId)}\t${tab.title}`).join('\n')
  return ENC.encode(lines === '' ? '' : `${lines}\n`)
}

async function readRange(
  accessor: GoogleApiAccessor,
  spreadsheetId: string,
  range: string,
  format: OutputFormat,
): Promise<Uint8Array> {
  if (format === 'csv') {
    return readValuesCsv(accessor.tokenManager, spreadsheetId, range)
  }
  return readValues(accessor.tokenManager, spreadsheetId, range)
}

async function gwsSheetsReadCommand(
  accessor: GoogleApiAccessor,
  _paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const spreadsheet = flagText(opts, 'spreadsheet')
  const idAlias = flagText(opts, 'id')
  const { id: sheetId, usedIdAlias } = resolveSpreadsheetId(opts, texts)
  if (sheetId === null) {
    if (spreadsheet !== '' && idAlias !== '') {
      return fail('--spreadsheet and --id must identify the same spreadsheet')
    }
    return fail('--spreadsheet or --id must contain a spreadsheet ID or share URL')
  }
  const format = outputFormat(opts, usedIdAlias)
  if (format === null) return fail('--format must be json or csv')

  const range = flagText(opts, 'range')
  const tab = flagText(opts, 'tab')
  const gid = flagText(opts, 'gid')
  const list = opts.flags.list === true
  const selectorCount =
    Number(range !== '') + Number(tab !== '') + Number(gid !== '') + Number(list)
  if (selectorCount > 1) {
    return fail('use only one of --range, --tab, --gid, or --list')
  }

  try {
    if (list) {
      return [formatTabList(await fetchSheetTabs(accessor.tokenManager, sheetId)), new IOResult()]
    }
    if (range !== '') {
      const out: ByteSource = await readRange(accessor, sheetId, range, format)
      return [out, new IOResult()]
    }
    if (tab !== '') {
      return [await readRange(accessor, sheetId, quoteSheetTitle(tab), format), new IOResult()]
    }
    if (gid !== '') {
      const gidNumber = Number(gid)
      if (!Number.isInteger(gidNumber)) return fail('--gid must be an integer')
      const tabs = await fetchSheetTabs(accessor.tokenManager, sheetId)
      const match = tabs.find((candidate) => candidate.sheetId === gidNumber)
      if (match === undefined) return fail(`no tab with gid ${gid}; use --list`, 1)
      return [
        await readRange(accessor, sheetId, quoteSheetTitle(match.title), format),
        new IOResult(),
      ]
    }

    let tabs: SheetTab[]
    try {
      tabs = await fetchSheetTabs(accessor.tokenManager, sheetId)
    } catch (err) {
      const warning = err instanceof Error ? err.message : String(err)
      const out = await exportFirstSheetCsv(accessor.tokenManager, sheetId)
      return [
        out,
        new IOResult({
          stderr: ENC.encode(
            `gws-sheets-read: tab metadata unavailable; returned the first tab as CSV (${warning})\n`,
          ),
        }),
      ]
    }
    if (tabs.length === 0) return fail('spreadsheet has no readable tabs', 1)
    if (tabs.length > 1) {
      return [
        formatTabList(tabs),
        new IOResult({
          stderr: ENC.encode(
            `gws-sheets-read: ${String(tabs.length)} tabs; use --tab, --gid, or --range to read one\n`,
          ),
        }),
      ]
    }
    return [
      await readRange(accessor, sheetId, quoteSheetTitle(tabs[0]?.title ?? ''), format),
      new IOResult(),
    ]
  } catch (err) {
    return fail(`gws-sheets-read: ${err instanceof Error ? err.message : String(err)}`, 1)
  }
}

export const GSHEETS_GWS_READ = command({
  name: 'gws-sheets-read',
  resource: [ResourceName.GSHEETS, ResourceName.GDRIVE],
  spec: SPEC,
  fn: gwsSheetsReadCommand,
  mountRouting: 'cwd-or-unique',
})

export const GSHEETS_GWS_READ_ALIAS = command({
  name: 'gws-sheet-read',
  resource: [ResourceName.GSHEETS, ResourceName.GDRIVE],
  spec: SPEC,
  fn: gwsSheetsReadCommand,
  mountRouting: 'cwd-or-unique',
})
