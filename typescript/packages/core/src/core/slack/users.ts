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

import type { SlackAccessor } from '../../accessor/slack.ts'
import { cursorPages } from './paginate.ts'

export interface SlackUser {
  id: string
  name?: string
  real_name?: string
  deleted?: boolean
  is_bot?: boolean
  profile?: { email?: string; [key: string]: unknown }
  [key: string]: unknown
}

function isRealUser(m: SlackUser): boolean {
  return m.deleted !== true && m.is_bot !== true && m.id !== 'USLACKBOT'
}

export async function* listUsersStream(
  accessor: SlackAccessor,
  options: { limit?: number } = {},
): AsyncIterableIterator<SlackUser[]> {
  const limit = options.limit ?? 200
  for await (const page of cursorPages<SlackUser>(
    accessor.transport,
    'users.list',
    { limit: String(limit) },
    'members',
  )) {
    yield page.filter(isRealUser)
  }
}

export async function listUsers(
  accessor: SlackAccessor,
  options: { limit?: number } = {},
): Promise<SlackUser[]> {
  const out: SlackUser[] = []
  for await (const page of listUsersStream(accessor, options)) {
    out.push(...page)
  }
  return out
}

export async function getUserProfile(
  accessor: SlackAccessor,
  userId: string,
): Promise<SlackUser | Record<string, never>> {
  const data = await accessor.transport.call('users.info', { user: userId })
  return (data.user as SlackUser | undefined) ?? {}
}

/** TSV rendering of the workspace user list. One row per user:
 *  `<user_id>\t<display_name>\t<real_name>\t<email>\t<is_bot>`
 *
 *  Serves /slack/users.tsv — lets agents bulk-resolve participants.txt
 *  user_ids without one cat+jq per id. Joins map cleanly:
 *    join -t$'\t' -1 1 -2 1 <(sort /slack/users.tsv) \
 *                           <(sort /slack/.../participants.txt)
 *
 *  Header line is included so awk/csvkit users see column names. Includes
 *  bots/deactivated users (filters off — different criteria than the
 *  /slack/users/ dir which hides them) so participants.txt with bot
 *  ids resolves too.
 *
 *  No tab/newline sanitization on display fields — slack rejects those
 *  upstream in user-settable fields, so the TSV is well-formed by
 *  construction. */
export async function getUsersTsv(accessor: SlackAccessor): Promise<Uint8Array> {
  const all: SlackUser[] = []
  for await (const page of cursorPages<SlackUser>(
    accessor.transport,
    'users.list',
    { limit: '200' },
    'members',
  )) {
    all.push(...page)
  }
  const lines = ['user_id\tdisplay_name\treal_name\temail\tis_bot']
  for (const u of all.sort((a, b) => a.id.localeCompare(b.id))) {
    const email = u.profile?.email ?? ''
    lines.push(
      [u.id, u.name ?? '', u.real_name ?? '', email, u.is_bot === true ? '1' : '0'].join('\t'),
    )
  }
  return new TextEncoder().encode(lines.join('\n') + '\n')
}

export async function searchUsers(
  accessor: SlackAccessor,
  query: string,
  options: { limit?: number } = {},
): Promise<SlackUser[]> {
  const all = await listUsers(accessor, options)
  const q = query.toLowerCase()
  return all.filter((u) => {
    if ((u.name ?? '').toLowerCase().includes(q)) return true
    if ((u.real_name ?? '').toLowerCase().includes(q)) return true
    const email = u.profile?.email ?? ''
    if (email.toLowerCase().includes(q)) return true
    return false
  })
}
