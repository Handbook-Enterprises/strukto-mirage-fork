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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { readdir as coreReaddir } from './readdir.ts'
import { resolveParentFolderId, targetedLookup } from './resolve.ts'

function enoent(p: string): Error & { code: string } {
  const e = new Error(`ENOENT: ${p}`) as Error & { code: string }
  e.code = 'ENOENT'
  return e
}

function guessType(name: string): FileType {
  const lower = name.toLowerCase()
  if (
    lower.endsWith('.json') ||
    lower.endsWith('.gdoc.json') ||
    lower.endsWith('.gsheet.json') ||
    lower.endsWith('.gslide.json')
  )
    return FileType.JSON
  if (lower.endsWith('.csv')) return FileType.CSV
  if (lower.endsWith('.png')) return FileType.IMAGE_PNG
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return FileType.IMAGE_JPEG
  if (lower.endsWith('.gif')) return FileType.IMAGE_GIF
  if (lower.endsWith('.zip')) return FileType.ZIP
  if (lower.endsWith('.gz') || lower.endsWith('.gzip')) return FileType.GZIP
  if (lower.endsWith('.pdf')) return FileType.PDF
  if (lower.endsWith('.parquet')) return FileType.PARQUET
  if (lower.endsWith('.orc')) return FileType.ORC
  if (lower.endsWith('.feather')) return FileType.FEATHER
  if (lower.endsWith('.h5') || lower.endsWith('.hdf5')) return FileType.HDF5
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.log'))
    return FileType.TEXT
  return FileType.BINARY
}

export async function stat(
  accessor: GDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const prefix = path.prefix
  let p = path.original
  if (prefix !== '' && p.startsWith(prefix)) p = p.slice(prefix.length) || '/'
  const key = p.replace(/^\/+|\/+$/g, '')
  if (key === '') return new FileStat({ name: '/', type: FileType.DIRECTORY })

  if (index === undefined) throw enoent(path.original)
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`
  let result = await index.get(virtualKey)
  if (result.entry === undefined || result.entry === null) {
    const parentVirtual = virtualKey.includes('/')
      ? virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
      : '/'
    // Fast negative lookup: a single targeted files.list (name= AND
    // parent=) instead of walking the entire parent folder. This turns a
    // missing-path stat on a warm parent from a multi-page network walk
    // (the /sessions minutes-long stall) into one bounded request. Only when
    // the parent id can't be resolved locally do we fall back to a full
    // parent listing, which recursively resolves ancestor ids as before.
    const targeted = await targetedLookup(accessor, virtualKey, parentVirtual, prefix, index)
    if (targeted !== null) {
      result = { entry: targeted }
    } else {
      const parentFolderId = await resolveParentFolderId(accessor, parentVirtual, prefix, index)
      if (parentFolderId !== null) {
        // Parent id was resolvable and the targeted query found nothing:
        // the child does not exist. Fail fast without listing the parent.
        throw enoent(path.original)
      }
      try {
        await coreReaddir(
          accessor,
          new PathSpec({
            original: parentVirtual,
            directory: parentVirtual,
            resolved: false,
            prefix,
          }),
          index,
        )
      } catch {
        // parent listing failed — fall through
      }
      result = await index.get(virtualKey)
      if (result.entry === undefined || result.entry === null) {
        throw enoent(path.original)
      }
    }
  }
  const entry = result.entry
  if (entry === undefined || entry === null) throw enoent(path.original)
  if (entry.resourceType === 'gdrive/folder') {
    return new FileStat({
      name: entry.vfsName !== '' ? entry.vfsName : entry.name,
      type: FileType.DIRECTORY,
      modified: entry.remoteTime,
      extra: { file_id: entry.id },
    })
  }
  return new FileStat({
    name: entry.vfsName !== '' ? entry.vfsName : entry.name,
    size: entry.size,
    type: guessType(entry.vfsName),
    modified: entry.remoteTime,
    fingerprint: entry.remoteTime !== '' ? entry.remoteTime : null,
    extra: {
      file_id: entry.id,
      resource_type: entry.resourceType,
    },
  })
}
