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

import type { NotionTransport } from './_client.ts'
import { stripDashes } from './pathing.ts'

type Json = Record<string, unknown>

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asObject(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

interface PaginateOptions {
  /** Cap the number of pagination round-trips. `undefined` = unbounded
   *  (legacy behavior). When the cap is hit, the function returns whatever
   *  has been collected so far — the caller treats this as a best-effort
   *  result. */
  maxPages?: number
}

async function paginateTool(
  transport: NotionTransport,
  toolName: string,
  baseArgs: Record<string, unknown>,
  options: PaginateOptions = {},
): Promise<Json[]> {
  const collected: Json[] = []
  let cursor: string | null = null
  let pages = 0
  for (;;) {
    const args: Record<string, unknown> =
      cursor === null ? { ...baseArgs } : { ...baseArgs, start_cursor: cursor }
    const response = await transport.callTool(toolName, args)
    const results = asArray(response.results)
    for (const item of results) {
      collected.push(asObject(item))
    }
    pages += 1
    if (options.maxPages !== undefined && pages >= options.maxPages) {
      return collected
    }
    const hasMore = response.has_more === true
    const next = response.next_cursor
    if (!hasMore || typeof next !== 'string' || next === '') {
      return collected
    }
    cursor = next
  }
}

export async function searchTopLevelPages(transport: NotionTransport): Promise<Json[]> {
  // Cap pagination at 10 rounds (≈1000 pages searched) to avoid 30s+ MCP
  // request timeouts on large workspaces. Notion's search API returns ALL
  // pages and we then filter to `parent.type === 'workspace'`, so paginating
  // fully through a workspace with thousands of pages takes many seconds
  // and often exceeds the MCP timeout. Cached results survive in the
  // workspace's IndexCacheStore so subsequent calls are fast even if the
  // first one returned a best-effort subset.
  //
  // Best-effort limitation: top-level pages whose `last_edited_time` is
  // older than the most recent 1000 pages in the workspace won't appear
  // until pagination is improved (per-path use of blocks/children + DBs/query
  // instead of workspace-wide search — see follow-up PR).
  const baseArgs = { filter: { value: 'page', property: 'object' }, page_size: 100 }
  const all = await paginateTool(transport, 'API-post-search', baseArgs, { maxPages: 10 })
  const filtered: Json[] = []
  for (const page of all) {
    const parent = asObject(page.parent)
    if (parent.type === 'workspace') filtered.push(page)
  }
  return filtered
}

export async function getPage(transport: NotionTransport, pageId: string): Promise<Json> {
  return transport.callTool('API-retrieve-a-page', { page_id: pageId })
}

export async function getChildBlocks(transport: NotionTransport, blockId: string): Promise<Json[]> {
  return paginateTool(transport, 'API-retrieve-block-children', {
    block_id: blockId,
    page_size: 100,
  })
}

export interface ChildPageRef {
  id: string
  title: string
}

export async function getChildPages(
  transport: NotionTransport,
  parentBlockId: string,
): Promise<ChildPageRef[]> {
  const blocks = await getChildBlocks(transport, parentBlockId)
  const refs: ChildPageRef[] = []
  for (const block of blocks) {
    if (block.type !== 'child_page') continue
    const id = block.id
    if (typeof id !== 'string') continue
    const childPage = asObject(block.child_page)
    const title = childPage.title
    refs.push({
      id: stripDashes(id).toLowerCase(),
      title: typeof title === 'string' ? title : '',
    })
  }
  return refs
}

export interface CreatePageInput {
  parent: { type: 'workspace' } | { type: 'page_id'; page_id: string }
  title: string
}

export async function createPage(
  transport: NotionTransport,
  input: CreatePageInput,
): Promise<Json> {
  const parentBody: Json =
    input.parent.type === 'workspace'
      ? { type: 'workspace', workspace: true }
      : { type: 'page_id', page_id: input.parent.page_id }
  const body: Json = {
    parent: parentBody,
    properties: {
      title: { title: [{ type: 'text', text: { content: input.title } }] },
    },
  }
  return transport.callTool('API-post-page', body)
}
