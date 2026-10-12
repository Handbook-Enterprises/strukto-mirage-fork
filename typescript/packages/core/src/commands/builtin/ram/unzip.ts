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

import { stream as ramStream } from '../../../core/ram/stream.ts'
import { writeBytes as ramWrite } from '../../../core/ram/write.ts'
import { mkdir as ramMkdir } from '../../../core/ram/mkdir.ts'
import type { RAMAccessor } from '../../../accessor/ram.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec, ResourceName } from '../../../types.ts'
import { inflateRaw } from '../../../utils/compress.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { UNZIP_MAX_UNCOMPRESSED_BYTES, unzipTooBig } from '../utils/unzip_limit.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

interface ZipHeader {
  name: string
  size: number
}

interface ZipEntry extends ZipHeader {
  data: Uint8Array
}

function readU16LE(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8)
}

function readU32LE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] ?? 0) |
      ((data[offset + 1] ?? 0) << 8) |
      ((data[offset + 2] ?? 0) << 16) |
      ((data[offset + 3] ?? 0) << 24)) >>>
    0
  )
}

async function readZipEntries(data: Uint8Array): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = []
  let inflated = 0
  let offset = 0
  while (offset + 4 <= data.byteLength) {
    const sig = readU32LE(data, offset)
    if (sig !== 0x04034b50) break
    const compressionMethod = readU16LE(data, offset + 8)
    const compressedSize = readU32LE(data, offset + 18)
    const uncompressedSize = readU32LE(data, offset + 22)
    const nameLen = readU16LE(data, offset + 26)
    const extraLen = readU16LE(data, offset + 28)
    const headerEnd = offset + 30 + nameLen + extraLen
    const nameBytes = data.subarray(offset + 30, offset + 30 + nameLen)
    const name = DEC.decode(nameBytes)
    const body = data.subarray(headerEnd, headerEnd + compressedSize)
    let content: Uint8Array
    if (compressionMethod === 0) {
      content = body.slice()
    } else if (compressionMethod === 8) {
      content = await inflateRaw(body)
    } else {
      throw new Error(`unzip: unsupported compression method: ${String(compressionMethod)}`)
    }
    inflated += content.byteLength
    if (inflated > UNZIP_MAX_UNCOMPRESSED_BYTES) throw unzipTooBig()
    entries.push({ name, size: uncompressedSize, data: content })
    offset = headerEnd + compressedSize
  }
  return entries
}

// Header-only scan: names and declared sizes, nothing inflated. Feeds the
// size pre-check and the -l listing (see UNZIP_MAX_UNCOMPRESSED_BYTES).
function readZipHeaders(data: Uint8Array): ZipHeader[] {
  const headers: ZipHeader[] = []
  let offset = 0
  while (offset + 4 <= data.byteLength) {
    const sig = readU32LE(data, offset)
    if (sig !== 0x04034b50) break
    const compressedSize = readU32LE(data, offset + 18)
    const uncompressedSize = readU32LE(data, offset + 22)
    const nameLen = readU16LE(data, offset + 26)
    const extraLen = readU16LE(data, offset + 28)
    const headerEnd = offset + 30 + nameLen + extraLen
    const nameBytes = data.subarray(offset + 30, offset + 30 + nameLen)
    const name = DEC.decode(nameBytes)
    headers.push({ name, size: uncompressedSize })
    offset = headerEnd + compressedSize
  }
  return headers
}

function makePathSpec(original: string): PathSpec {
  return new PathSpec({ original, directory: original, resolved: true })
}

async function ensureParents(accessor: RAMAccessor, path: string): Promise<void> {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return
  const dir = path.slice(0, idx)
  if (dir === '' || dir === '/') return
  await ramMkdir(accessor, makePathSpec(dir), true)
}

async function unzipCommand(
  accessor: RAMAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('unzip: missing operand\n') })]
  }
  const archivePath = paths[0]
  if (archivePath === undefined) return [null, new IOResult()]
  const data = await materialize(ramStream(accessor, archivePath))

  const listMode = opts.flags.args_l === true
  const testMode = opts.flags.t === true
  const headers = readZipHeaders(data)
  if (!listMode) {
    let totalUncompressed = 0
    for (const h of headers) totalUncompressed += h.size
    if (totalUncompressed > UNZIP_MAX_UNCOMPRESSED_BYTES) throw unzipTooBig(archivePath.original)
  }
  // Listing needs only the headers, so -l never inflates (and is never refused).
  const entries = listMode ? headers : await readZipEntries(data)
  const pipeMode = opts.flags.p === true
  const quiet = opts.flags.q === true
  const mountPrefix = archivePath.prefix
  const destRaw = typeof opts.flags.d === 'string' ? opts.flags.d : '/'
  const dest =
    mountPrefix !== '' && destRaw.startsWith(mountPrefix + '/')
      ? destRaw.slice(mountPrefix.length)
      : destRaw === mountPrefix
        ? '/'
        : destRaw

  if (listMode) {
    const lines = ['  Length      Name', '---------  ----']
    for (const e of entries) {
      lines.push(`${String(e.size).padStart(9, ' ')}  ${e.name}`)
    }
    const out: ByteSource = ENC.encode(lines.join('\n') + '\n')
    return [out, new IOResult()]
  }

  if (testMode) {
    const msg = `No errors detected in ${archivePath.original}\n`
    const out: ByteSource = ENC.encode(msg)
    return [out, new IOResult()]
  }

  // Not list mode, so entries came from readZipEntries and carry their data.
  const members = entries as ZipEntry[]

  if (pipeMode) {
    const chunks: Uint8Array[] = []
    for (const e of members) {
      if (!e.name.endsWith('/')) chunks.push(e.data)
    }
    let total = 0
    for (const c of chunks) total += c.byteLength
    const merged = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      merged.set(c, offset)
      offset += c.byteLength
    }
    const out: ByteSource = merged
    return [out, new IOResult()]
  }

  const writes: Record<string, Uint8Array> = {}
  const outputLines: string[] = []
  for (const e of members) {
    if (e.name.endsWith('/')) continue
    const entryName = e.name.replace(/^\/+/, '')
    const outPath = dest.replace(/\/+$/, '') + '/' + entryName
    await ensureParents(accessor, outPath)
    await ramWrite(accessor, makePathSpec(outPath), e.data)
    const reportPath = mountPrefix !== '' ? mountPrefix + outPath : outPath
    writes[reportPath] = e.data
    if (!quiet) outputLines.push(`  inflating: ${reportPath}`)
  }
  const stdout: ByteSource | null =
    outputLines.length > 0 ? ENC.encode(outputLines.join('\n') + '\n') : null
  return [stdout, new IOResult({ writes })]
}

export const RAM_UNZIP = command({
  name: 'unzip',
  resource: ResourceName.RAM,
  spec: specOf('unzip'),
  fn: unzipCommand,
  write: true,
})
