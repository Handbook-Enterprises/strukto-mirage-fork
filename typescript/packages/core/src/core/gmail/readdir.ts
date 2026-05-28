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

import { applyMountFilter } from '../../utils/mount_filter.ts'
import type { GmailAccessor } from '../../accessor/gmail.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { listLabels } from './labels.ts'
import type { GmailHeader, GmailMessageRaw, GmailThreadFull } from './messages.ts'
import {
  extractAttachments,
  extractHeader,
  getMessageRaw,
  getThreadFull,
  listMessages,
  listThreads,
  parseAddress,
} from './messages.ts'

const THREADS_DIR = 'threads'
const PARTICIPANTS_FILE = 'participants.txt'
const THREAD_META_FILE = 'meta.json'
/** How many threads to enumerate when listing /gmail/threads/. The INBOX
 *  list endpoint returns most-recent first; 50 covers a typical work
 *  week's active conversations without paginating. */
const THREAD_LIST_LIMIT = 50

/** Strip leading reply/forward prefixes (Re:, RE:, Fwd:, FW:, repeated)
 *  before slugging — they're noise in a directory name where the agent is
 *  trying to spot the actual subject. */
function stripReplyPrefixes(subject: string): string {
  let s = subject.trim()
  for (let i = 0; i < 10; i++) {
    const m = /^(re|fwd?)\s*:\s*/i.exec(s)
    if (m === null) break
    s = s.slice(m[0].length)
  }
  return s
}

/** Pick the most informative subject across the messages in a thread.
 *  Threads often start with a stub or empty subject and the real topic
 *  arrives in a later reply; take the longest non-empty subject after
 *  stripping reply prefixes. Falls back to "no-subject". */
function bestThreadSubject(messages: GmailMessageRaw[]): string {
  let best = ''
  for (const m of messages) {
    const raw = extractHeader(m.payload?.headers, 'Subject')
    const cleaned = stripReplyPrefixes(raw)
    if (cleaned.length > best.length) best = cleaned
  }
  return best === '' ? 'no-subject' : best
}

/** YYYY-MM string from a message's internalDate (ms since epoch). Used in
 *  thread dirnames so `ls /gmail/threads/ | sort` groups by month. */
function monthFromInternal(internalDate: string | undefined): string {
  if (internalDate === undefined) return '0000-00'
  const ts = Number.parseInt(internalDate, 10)
  if (!Number.isFinite(ts)) return '0000-00'
  const d = new Date(ts)
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0')
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  return `${yyyy}-${mm}`
}

/** Build a thread-directory base name: `YYYY-MM__slug__threadId`. The
 *  slug uses the existing message sanitize() so chars are filesystem-safe
 *  and the slug never contains the `__` separator. Sorts chronologically
 *  by month; thread_id is parsed back from the trailing segment on read. */
function threadDirName(thread: GmailThreadFull): string {
  const tid = thread.id ?? ''
  const msgs = thread.messages ?? []
  // Take the latest message's date so an active thread keeps surfacing
  // in the current month even if it started months ago.
  const latest = msgs[msgs.length - 1]
  const month = monthFromInternal(latest?.internalDate)
  const slug = sanitize(bestThreadSubject(msgs))
  return `${month}__${slug}__${tid}`
}

/** Extract thread_id from a directory name produced by threadDirName.
 *  Returns null on any unexpected shape so callers can fall through to
 *  ENOENT instead of querying with garbage. */
function parseThreadDirName(name: string): string | null {
  const sep = name.lastIndexOf('__')
  if (sep === -1) return null
  const id = name.slice(sep + 2)
  return id === '' ? null : id
}

/** Per-message filename inside a thread directory:
 *    01-from-alice.gmail.json, 02-from-bob.gmail.json ...
 *  Sortable by index; `from-` carries the most useful single piece of
 *  context for skimming the conversation. The `.gmail.json` extension
 *  matches the rest of the gmail mount so existing rg/grep/collectFiles
 *  helpers pick these up; the file content IS JSON (same shape as
 *  getMessageProcessed returns elsewhere). */
function threadMessageFilename(index: number, msg: GmailMessageRaw): string {
  const fromRaw = extractHeader(msg.payload?.headers, 'From').trim()
  let sender = 'unknown'
  if (fromRaw !== '') {
    const addr = parseAddress(fromRaw)
    if (addr.name !== '') sender = sanitize(addr.name)
    else if (addr.email !== '') sender = sanitize(addr.email.split('@')[0] ?? addr.email)
  }
  const idx = index.toString().padStart(2, '0')
  return `${idx}-from-${sender}.gmail.json`
}

/** Parse a thread message filename back into its 1-based index. Returns
 *  null for participants.txt / meta.json (handled separately) or any
 *  shape we didn't produce. Accepts both `.gmail.json` (current) and
 *  `.eml` (legacy from a brief 0.1.0-viewengine.6 window) so cached
 *  sessions don't break across the bump. */
function parseThreadMessageFilename(name: string): number | null {
  if (!name.endsWith('.gmail.json') && !name.endsWith('.eml')) return null
  const m = /^(\d{2,})-from-/.exec(name)
  if (m === null) return null
  const idx = Number.parseInt(m[1] ?? '', 10)
  return Number.isFinite(idx) && idx > 0 ? idx : null
}

/** Union of every From/To/Cc/Bcc email seen across a thread's messages,
 *  deduped and lowercased. Written one-per-line to participants.txt;
 *  enables `grep -l alice@x.com /gmail/threads/.../participants.txt` for
 *  fast cross-ref with calendar's attendees.txt. */
function threadParticipants(messages: GmailMessageRaw[]): string[] {
  const seen = new Set<string>()
  for (const m of messages) {
    const headers = m.payload?.headers
    for (const hdr of ['From', 'To', 'Cc', 'Bcc']) {
      const raw = extractHeader(headers, hdr)
      if (raw === '') continue
      for (const part of raw.split(',')) {
        const addr = parseAddress(part.trim())
        if (addr.email !== '') seen.add(addr.email.toLowerCase())
      }
    }
  }
  return [...seen].sort()
}

// Re-export so read.ts can reuse without duplicating logic.
export {
  parseThreadDirName,
  parseThreadMessageFilename,
  threadParticipants,
  THREADS_DIR,
  THREAD_META_FILE,
  PARTICIPANTS_FILE,
}

const TITLE_MAX = 80
const UNSAFE = /[^\w\s\-.]/g
const MULTI_UNDERSCORE = /_+/g

export function sanitize(text: string): string {
  if (text.trim() === '') return 'No_Subject'
  let cleaned = text.replace(UNSAFE, '_').replace(/ /g, '_')
  cleaned = cleaned.replace(MULTI_UNDERSCORE, '_').replace(/^_+|_+$/g, '')
  if (cleaned.length > TITLE_MAX) cleaned = `${cleaned.slice(0, TITLE_MAX - 3)}...`
  return cleaned
}

/** Best human-readable title for a message, used as the filename slug.
 *  Falls through Subject → From-name → From-email-localpart → "no-subject"
 *  so empty-subject auto-replies / calendar invites / no-reply notifications
 *  surface a useful identifier instead of bare `No_Subject__<msgid>` (which
 *  is indistinguishable across the inbox). */
export function bestTitle(headers: GmailHeader[] | undefined): string {
  const subject = extractHeader(headers, 'Subject').trim()
  if (subject !== '') return sanitize(subject)
  const fromRaw = extractHeader(headers, 'From').trim()
  if (fromRaw !== '') {
    const addr = parseAddress(fromRaw)
    if (addr.name !== '') return sanitize(`from-${addr.name}`)
    if (addr.email !== '') {
      const local = addr.email.split('@')[0] ?? addr.email
      return sanitize(`from-${local}`)
    }
  }
  return 'no-subject'
}

function msgFilename(headers: GmailHeader[] | undefined, msgId: string): string {
  return `${bestTitle(headers)}__${msgId}.gmail.json`
}

function dateFromInternal(internalDate: string | undefined): string {
  if (internalDate === undefined) return '1970-01-01'
  const ts = Number.parseInt(internalDate, 10)
  if (!Number.isFinite(ts)) return '1970-01-01'
  const d = new Date(ts)
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0')
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = d.getUTCDate().toString().padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function enoent(p: string): Error {
  const e = new Error(`ENOENT: ${p}`) as Error & { code: string }
  e.code = 'ENOENT'
  return e
}

export async function readdir(...args: Parameters<typeof readdirImpl>): Promise<string[]> {
  const out = await readdirImpl(...args)
  const p = args[1] as { prefix?: string } | string | undefined
  const prefix = typeof p === 'string' || p == null ? '' : (p.prefix ?? '')
  return applyMountFilter(out, prefix)
}

async function readdirImpl(
  accessor: GmailAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const prefix = path.prefix
  const raw = path.pattern !== null ? path.directory : path.original
  let p = raw
  if (prefix !== '' && p.startsWith(prefix)) p = p.slice(prefix.length) || '/'
  const key = p.replace(/^\/+|\/+$/g, '')
  const virtualKey = key !== '' ? `${prefix}/${key}` : prefix !== '' ? prefix : '/'
  const parts = key === '' ? [] : key.split('/')
  const depth = parts.length

  if (depth === 0) {
    if (index !== undefined) {
      const cached = await index.listDir(virtualKey)
      if (cached.entries !== undefined && cached.entries !== null) return cached.entries
    }
    const labels = await listLabels(accessor.tokenManager)
    const entries: [string, IndexEntry][] = []
    // Synthetic top-level entry that exposes the conversation-oriented
    // view; lives alongside the label-based view (INBOX, SENT, etc.) so
    // agents can choose whichever fits the task. ID is irrelevant since
    // read.ts dispatches the threads/ subtree directly without an index
    // lookup; we still register it so `ls /gmail/` returns it.
    entries.push([
      THREADS_DIR,
      new IndexEntry({
        id: THREADS_DIR,
        name: THREADS_DIR,
        resourceType: 'gmail/threads_root',
        vfsName: THREADS_DIR,
      }),
    ])
    for (const lb of labels) {
      const name = lb.type === 'system' ? lb.id : (lb.name ?? lb.id)
      const entry = new IndexEntry({
        id: lb.id,
        name,
        resourceType: 'gmail/label',
        vfsName: name,
      })
      entries.push([name, entry])
    }
    if (index !== undefined) await index.setDir(virtualKey, entries)
    return entries.map(([name]) => `${prefix}/${name}`)
  }

  // /gmail/threads/ — list recent conversations as directories named
  // <YYYY-MM>__<slug>__<thread_id>. Each dir holds chronologically
  // numbered message files plus participants.txt and meta.json.
  if (depth === 1 && parts[0] === THREADS_DIR) {
    if (index !== undefined) {
      const cached = await index.listDir(virtualKey)
      if (cached.entries !== undefined && cached.entries !== null) return cached.entries
    }
    // List thread STUBS (id + snippet) cheaply, then fetch each full
    // thread to compute the dirname. INBOX scope keeps the working set
    // bounded; agents who need a wider view can drop into label/date
    // directories instead.
    const stubs = await listThreads(accessor.tokenManager, {
      labelId: 'INBOX',
      maxResults: THREAD_LIST_LIMIT,
    })
    const entries: [string, IndexEntry][] = []
    for (const stub of stubs) {
      let thread: GmailThreadFull
      try {
        thread = await getThreadFull(accessor.tokenManager, stub.id)
      } catch {
        continue
      }
      const dirName = threadDirName(thread)
      entries.push([
        dirName,
        new IndexEntry({
          id: stub.id,
          name: dirName,
          resourceType: 'gmail/thread_dir',
          vfsName: dirName,
        }),
      ])
    }
    if (index !== undefined) await index.setDir(virtualKey, entries)
    return entries.map(([name]) => `${prefix}/${THREADS_DIR}/${name}`)
  }

  // /gmail/threads/<dirname>/ — list message files + participants.txt + meta.json
  if (depth === 2 && parts[0] === THREADS_DIR) {
    if (index !== undefined) {
      const cached = await index.listDir(virtualKey)
      if (cached.entries !== undefined && cached.entries !== null) return cached.entries
    }
    const tid = parseThreadDirName(parts[1] ?? '')
    if (tid === null) throw enoent(path.original)
    const thread = await getThreadFull(accessor.tokenManager, tid)
    const msgs = thread.messages ?? []
    const entries: [string, IndexEntry][] = []
    msgs.forEach((msg, i) => {
      const fname = threadMessageFilename(i + 1, msg)
      entries.push([
        fname,
        new IndexEntry({
          id: msg.id ?? '',
          name: fname,
          resourceType: 'gmail/thread_message',
          vfsName: fname,
          size: msg.sizeEstimate ?? null,
        }),
      ])
    })
    entries.push([
      PARTICIPANTS_FILE,
      new IndexEntry({
        id: `${tid}:participants`,
        name: PARTICIPANTS_FILE,
        resourceType: 'gmail/thread_participants',
        vfsName: PARTICIPANTS_FILE,
      }),
    ])
    entries.push([
      THREAD_META_FILE,
      new IndexEntry({
        id: `${tid}:meta`,
        name: THREAD_META_FILE,
        resourceType: 'gmail/thread_meta',
        vfsName: THREAD_META_FILE,
      }),
    ])
    if (index !== undefined) await index.setDir(virtualKey, entries)
    return entries.map(([name]) => `${prefix}/${THREADS_DIR}/${parts[1] ?? ''}/${name}`)
  }

  if (depth === 1) {
    const labelName = parts[0] ?? ''
    if (index !== undefined) {
      const cached = await index.listDir(virtualKey)
      if (cached.entries !== undefined && cached.entries !== null) return cached.entries
    }
    if (index === undefined) throw enoent(path.original)
    const labelKey = prefix !== '' ? `${prefix}/${labelName}` : `/${labelName}`
    let result = await index.get(labelKey)
    if (result.entry === undefined || result.entry === null) {
      try {
        const root = new PathSpec({
          original: prefix !== '' ? prefix : '/',
          directory: prefix !== '' ? prefix : '/',
          prefix,
        })
        await readdir(accessor, root, index)
        result = await index.get(labelKey)
      } catch {
        // ignore — falls through to ENOENT below
      }
    }
    if (result.entry === undefined || result.entry === null) throw enoent(path.original)
    const labelId = result.entry.id
    const msgIds = await listMessages(accessor.tokenManager, { labelId, maxResults: 50 })
    const dateGroups = new Map<string, GmailMessageRaw[]>()
    for (const m of msgIds) {
      const mid = m.id
      const rawMsg = await getMessageRaw(accessor.tokenManager, mid)
      const dateStr = dateFromInternal(rawMsg.internalDate)
      let bucket = dateGroups.get(dateStr)
      if (bucket === undefined) {
        bucket = []
        dateGroups.set(dateStr, bucket)
      }
      bucket.push(rawMsg)
    }
    const sortedDates = [...dateGroups.keys()].sort().reverse()
    const dateEntries: [string, IndexEntry][] = []
    for (const dateStr of sortedDates) {
      const dateEntry = new IndexEntry({
        id: dateStr,
        name: dateStr,
        resourceType: 'gmail/date',
        vfsName: dateStr,
      })
      dateEntries.push([dateStr, dateEntry])
      const msgEntries: [string, IndexEntry][] = []
      for (const rawMsg of dateGroups.get(dateStr) ?? []) {
        const mid = rawMsg.id ?? ''
        const headers = rawMsg.payload?.headers ?? []
        const subject = extractHeader(headers, 'Subject') || 'No Subject'
        const filename = msgFilename(headers, mid)
        const msgEntry = new IndexEntry({
          id: mid,
          name: subject,
          resourceType: 'gmail/message',
          vfsName: filename,
          size: rawMsg.sizeEstimate ?? null,
        })
        msgEntries.push([filename, msgEntry])
        const attachments = extractAttachments(rawMsg.payload)
        if (attachments.length > 0) {
          const attDirName = filename.replace('.gmail.json', '')
          const attDirEntry = new IndexEntry({
            id: mid,
            name: attDirName,
            resourceType: 'gmail/attachment_dir',
            vfsName: attDirName,
          })
          msgEntries.push([attDirName, attDirEntry])
          const attEntries: [string, IndexEntry][] = []
          for (const att of attachments) {
            const attEntry = new IndexEntry({
              id: att.attachmentId,
              name: att.filename,
              resourceType: 'gmail/attachment',
              vfsName: att.filename,
              size: att.size,
            })
            attEntries.push([att.filename, attEntry])
          }
          const attDirVKey = `${virtualKey}/${dateStr}/${attDirName}`
          await index.setDir(attDirVKey, attEntries)
        }
      }
      const dateVKey = `${virtualKey}/${dateStr}`
      await index.setDir(dateVKey, msgEntries)
    }
    await index.setDir(virtualKey, dateEntries)
    return dateEntries.map(([name]) => `${prefix}/${key}/${name}`)
  }

  if (depth === 2 || depth === 3) {
    if (index === undefined) throw enoent(path.original)
    let cached = await index.listDir(virtualKey)
    if (cached.entries !== undefined && cached.entries !== null) return cached.entries
    const labelPath = prefix !== '' ? `${prefix}/${parts[0] ?? ''}` : `/${parts[0] ?? ''}`
    const labelSpec = new PathSpec({ original: labelPath, directory: labelPath, prefix })
    await readdir(accessor, labelSpec, index)
    cached = await index.listDir(virtualKey)
    if (cached.entries !== undefined && cached.entries !== null) return cached.entries
    throw enoent(path.original)
  }

  throw enoent(path.original)
}
