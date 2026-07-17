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

import type { GSheetsAccessor } from '../../accessor/gsheets.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import {
  DRIVE_API_BASE,
  SHEETS_API_BASE,
  type TokenManager,
  googleGet,
  googleGetBytes,
} from '../google/_client.ts'
import { readdir } from './readdir.ts'

const ENC = new TextEncoder()

export interface SheetTab {
  title: string
  sheetId: number
  index: number
}

interface ValuesResponse {
  values?: unknown[][]
}

export function parseSpreadsheetId(raw: string): string | null {
  const value = raw.trim()
  if (value === '') return null
  const pathMatch = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(value)
  if (pathMatch?.[1] !== undefined) return pathMatch[1]
  const queryMatch = /[?&]id=([A-Za-z0-9_-]+)/.exec(value)
  if (queryMatch?.[1] !== undefined) return queryMatch[1]
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : null
}

export function quoteSheetTitle(title: string): string {
  return /^[A-Za-z0-9_]+$/.test(title) ? title : `'${title.replaceAll("'", "''")}'`
}

function csvCell(value: unknown): string {
  let text: string
  if (value == null) text = ''
  else if (typeof value === 'string') text = value
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    text = String(value)
  } else {
    text = JSON.stringify(value)
  }
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function valuesToCsv(values: readonly (readonly unknown[])[]): string {
  return values.map((row) => row.map(csvCell).join(',')).join('\n')
}

function enoent(p: string): Error {
  const e = new Error(`ENOENT: ${p}`) as Error & { code: string }
  e.code = 'ENOENT'
  return e
}

export async function readSpreadsheet(
  tm: TokenManager,
  spreadsheetId: string,
): Promise<Uint8Array> {
  const url = `${SHEETS_API_BASE}/spreadsheets/${spreadsheetId}`
  const data = await googleGet(tm, url)
  return ENC.encode(JSON.stringify(data))
}

export async function readValues(
  tm: TokenManager,
  spreadsheetId: string,
  range: string,
): Promise<Uint8Array> {
  const url = `${SHEETS_API_BASE}/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`
  const data = await googleGet(tm, url)
  return ENC.encode(JSON.stringify(data))
}

export async function readValuesCsv(
  tm: TokenManager,
  spreadsheetId: string,
  range: string,
): Promise<Uint8Array> {
  const url = `${SHEETS_API_BASE}/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`
  const data = (await googleGet(tm, url)) as ValuesResponse
  return ENC.encode(valuesToCsv(data.values ?? []))
}

export async function exportFirstSheetCsv(
  tm: TokenManager,
  spreadsheetId: string,
): Promise<Uint8Array> {
  const mime = encodeURIComponent('text/csv')
  const url = `${DRIVE_API_BASE}/files/${spreadsheetId}/export?mimeType=${mime}&supportsAllDrives=true`
  return googleGetBytes(tm, url)
}

export async function fetchSheetTabs(tm: TokenManager, spreadsheetId: string): Promise<SheetTab[]> {
  const fields = 'sheets.properties(sheetId,title,index)'
  const url = `${SHEETS_API_BASE}/spreadsheets/${spreadsheetId}`
  const data = (await googleGet(tm, url, { fields })) as {
    sheets?: { properties?: { sheetId?: number; title?: string; index?: number } }[]
  }
  const tabs: SheetTab[] = []
  for (const sheet of data.sheets ?? []) {
    const properties = sheet.properties
    if (
      properties?.title === undefined ||
      properties.sheetId === undefined ||
      properties.index === undefined
    ) {
      continue
    }
    tabs.push({
      title: properties.title,
      sheetId: properties.sheetId,
      index: properties.index,
    })
  }
  return tabs.sort((a, b) => a.index - b.index)
}

export async function fetchSheetNames(tm: TokenManager, spreadsheetId: string): Promise<string[]> {
  const fields = 'sheets.properties.title'
  const url = `${SHEETS_API_BASE}/spreadsheets/${spreadsheetId}?fields=${fields}`
  const data = (await googleGet(tm, url)) as {
    sheets?: { properties?: { title?: string } }[]
  }
  const out: string[] = []
  for (const s of data.sheets ?? []) {
    if (s.properties?.title !== undefined) out.push(s.properties.title)
  }
  return out
}

export async function read(
  accessor: GSheetsAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const prefix = path.prefix
  let p = path.original
  if (prefix !== '' && p.startsWith(prefix)) p = p.slice(prefix.length) || '/'
  const key = p.replace(/^\/+|\/+$/g, '')
  if (index === undefined) throw enoent(path.original)
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`
  let result = await index.get(virtualKey)
  if (result.entry === undefined || result.entry === null) {
    const parentKey = virtualKey.replace(/\/+$/, '').replace(/\/[^/]+$/, '') || '/'
    if (parentKey !== virtualKey) {
      const parentPath = PathSpec.fromStrPath(parentKey, prefix)
      try {
        await readdir(accessor, parentPath, index)
        result = await index.get(virtualKey)
      } catch {
        // parent refresh failed; fall through to ENOENT
      }
    }
    if (result.entry === undefined || result.entry === null) throw enoent(path.original)
  }
  return readSpreadsheet(accessor.tokenManager, result.entry.id)
}

export async function* stream(
  accessor: GSheetsAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield await read(accessor, path, index)
}
