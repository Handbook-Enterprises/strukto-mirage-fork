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

import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import type { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { MIME_TO_EXT, findFileInFolder } from '../google/drive.ts'
import { driveFileToEntry } from './readdir.ts'

const WORKSPACE_EXTS: readonly string[] = Object.values(MIME_TO_EXT)

export function driveNameCandidates(leaf: string): string[] {
  const candidates = [leaf]
  for (const ext of WORKSPACE_EXTS) {
    if (leaf.endsWith(ext)) candidates.push(leaf.slice(0, leaf.length - ext.length))
  }
  return candidates
}

export async function resolveParentFolderId(
  accessor: GDriveAccessor,
  parentVirtual: string,
  prefix: string,
  index: IndexCacheStore,
): Promise<string | null> {
  let rel = parentVirtual
  if (prefix !== '' && rel.startsWith(prefix)) rel = rel.slice(prefix.length) || '/'
  const parentKey = rel.replace(/^\/+|\/+$/g, '')
  if (parentKey === '') {
    const scope = accessor.rootScope
    if (scope.type === 'my_drive') return 'root'
    return scope.id !== undefined && scope.id !== '' ? scope.id : null
  }
  const parentResult = await index.get(parentVirtual)
  const parentEntry = parentResult.entry
  if (parentEntry === undefined || parentEntry === null) return null
  if (parentEntry.resourceType !== 'gdrive/folder') return null
  return parentEntry.id
}

export async function targetedLookup(
  accessor: GDriveAccessor,
  virtualKey: string,
  parentVirtual: string,
  prefix: string,
  index: IndexCacheStore,
): Promise<IndexEntry | null> {
  const folderId = await resolveParentFolderId(accessor, parentVirtual, prefix, index)
  if (folderId === null) return null
  const leaf = virtualKey.slice(virtualKey.lastIndexOf('/') + 1)
  const matches = await findFileInFolder(accessor.tokenManager, folderId, driveNameCandidates(leaf))
  for (const f of matches) {
    const mapped = driveFileToEntry(f)
    if (mapped.name === leaf) {
      await index.put(virtualKey, mapped.entry)
      return mapped.entry
    }
  }
  return null
}
