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

import type { DropboxAccessor } from '../../../accessor/dropbox.ts'
import {
  collectJqFlags,
  concatBytes,
  formatJqOutput,
  jqEval,
  parseJsonAuto,
  parseJsonPath,
} from '../../../core/jq/index.ts'
import { resolveGlob } from '../../../core/dropbox/glob.ts'
import { read as dropboxRead } from '../../../core/dropbox/read.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { readStdinAsync } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function jqCommand(
  accessor: DropboxAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  if (texts.length === 0 || texts[0] === undefined) {
    return [
      null,
      new IOResult({ exitCode: 2, stderr: ENC.encode('jq: usage: jq EXPRESSION [path]\n') }),
    ]
  }
  const expression = texts[0]
  const { raw, compact, slurp, nullInput, evalFlags, rawfiles } = collectJqFlags(opts.flags)

  for (const rf of rawfiles) {
    try {
      const spec = PathSpec.fromStrPath(rf.path, opts.mountPrefix ?? '')
      const bytes = await dropboxRead(accessor, spec, opts.index ?? undefined)
      evalFlags.push('--arg', rf.name, DEC.decode(bytes))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`jq: ${msg}\n`) })]
    }
  }

  const expr = expression.trim()
  const spread = expression.includes('[]')

  if (nullInput) {
    const result = await jqEval(null, expr, evalFlags)
    return [formatJqOutput(result, raw, compact, spread), new IOResult()]
  }

  if (paths.length > 0) {
    const resolved = await resolveGlob(accessor, paths, opts.index ?? undefined)
    const parts: Uint8Array[] = []
    for (const p of resolved) {
      const bytes = await dropboxRead(accessor, p, opts.index ?? undefined)
      let data = parseJsonPath(bytes, p.original)
      if (slurp) data = Array.isArray(data) ? data : [data]
      const result = await jqEval(data, expr, evalFlags)
      parts.push(formatJqOutput(result, raw, compact, spread))
    }
    const out: ByteSource = concatBytes(parts)
    return [out, new IOResult()]
  }
  const bytes = await readStdinAsync(opts.stdin)
  if (bytes === null) {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('jq: missing input\n') })]
  }
  let data = parseJsonAuto(bytes)
  if (slurp && !Array.isArray(data)) data = [data]
  const result = await jqEval(data, expr, evalFlags)
  const out: ByteSource = formatJqOutput(result, raw, compact, spread)
  return [out, new IOResult()]
}

export const DROPBOX_JQ = command({
  name: 'jq',
  resource: ResourceName.DROPBOX,
  spec: specOf('jq'),
  fn: jqCommand,
})
