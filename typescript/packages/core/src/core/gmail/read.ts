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

import type { GmailAccessor } from '../../accessor/gmail.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { getAttachment, getMessageProcessed, getThreadFull } from './messages.ts'
import {
  PARTICIPANTS_FILE,
  parseThreadDirName,
  parseThreadMessageFilename,
  readdir,
  threadParticipants,
  THREADS_DIR,
  THREAD_META_FILE,
} from './readdir.ts'

const ENC = new TextEncoder()

function enoent(p: string): Error {
  const e = new Error(`ENOENT: ${p}`) as Error & { code: string }
  e.code = 'ENOENT'
  return e
}

function eisdir(p: string): Error {
  const e = new Error(`EISDIR: ${p}`) as Error & { code: string }
  e.code = 'EISDIR'
  return e
}

function dirname(p: string): string {
  const norm = p.replace(/\/+$/, '')
  const idx = norm.lastIndexOf('/')
  if (idx <= 0) return '/'
  return norm.slice(0, idx)
}

export async function read(
  accessor: GmailAccessor,
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
    const parentKey = dirname(virtualKey)
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
  const rt = result.entry.resourceType
  if (
    rt === 'gmail/label' ||
    rt === 'gmail/date' ||
    rt === 'gmail/attachment_dir' ||
    rt === 'gmail/threads_root' ||
    rt === 'gmail/thread_dir'
  ) {
    throw eisdir(path.original)
  }
  if (rt === 'gmail/attachment') {
    const parentKey = dirname(virtualKey)
    const parentResult = await index.get(parentKey)
    if (parentResult.entry === undefined || parentResult.entry === null) {
      throw enoent(path.original)
    }
    return getAttachment(accessor.tokenManager, parentResult.entry.id, result.entry.id)
  }
  // Synthetic per-thread sidecar files. The IndexEntry's id was set to
  // `<threadId>:participants` / `<threadId>:meta` at directory-listing
  // time so we can recover the real threadId without re-parsing the dir
  // name. participants.txt is one email per line (deduped, sorted) —
  // pairs with calendar's per-event attendees.txt for cross-mount
  // `grep -l <email>` queries. meta.json is the thread shell from
  // gmail.users.threads.get without per-message payloads (size +
  // historyId only) so agents can see "is this thread big? recent?"
  // without paying for full bodies.
  if (rt === 'gmail/thread_participants' || rt === 'gmail/thread_meta') {
    const [tid, kind] = result.entry.id.split(':', 2)
    if (tid === undefined || tid === '') throw enoent(path.original)
    const thread = await getThreadFull(accessor.tokenManager, tid)
    if (kind === 'participants') {
      const lines = threadParticipants(thread.messages ?? [])
      return ENC.encode(lines.length === 0 ? '' : `${lines.join('\n')}\n`)
    }
    return ENC.encode(
      JSON.stringify({
        id: thread.id,
        historyId: thread.historyId,
        messageCount: thread.messages?.length ?? 0,
      }),
    )
  }
  const processed = await getMessageProcessed(accessor.tokenManager, result.entry.id)
  return ENC.encode(JSON.stringify(processed))
}

// Touch unused imports so eslint/tsc don't flag them; they're part of the
// public surface for callers reading thread paths from outside read.ts.
void PARTICIPANTS_FILE
void THREAD_META_FILE
void THREADS_DIR
void parseThreadDirName
void parseThreadMessageFilename
