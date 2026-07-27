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
import { stat as ramStat } from '../../../core/ram/stat.ts'
import type { RAMAccessor } from '../../../accessor/ram.ts'
import {
  collectJqFlags,
  concatBytes,
  evalJsonlStream,
  formatJqOutput,
  isJsonlPath,
  isStreamableJsonlExpr,
  jqEval,
  parseJsonAuto,
  parseJsonPath,
} from '../../../core/jq/index.ts'
import { Precision, ProvisionResult } from '../../../provision/types.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { readStdinAsync } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

export async function jqProvision(
  accessor: RAMAccessor,
  paths: PathSpec[],
  texts: string[],
  _opts: CommandOpts,
): Promise<ProvisionResult> {
  const [first] = paths
  const [expr] = texts
  if (first === undefined || expr === undefined) return new ProvisionResult({ command: 'jq' })
  try {
    const s = await ramStat(accessor, first)
    const fileSize = s.size ?? 0
    if (isJsonlPath(first.original) && isStreamableJsonlExpr(expr)) {
      return new ProvisionResult({
        command: `jq '${expr}' ${first.original}`,
        networkReadLow: 0,
        networkReadHigh: fileSize,
        readOps: 1,
        precision: Precision.RANGE,
      })
    }
    return new ProvisionResult({
      command: `jq '${expr}' ${first.original}`,
      networkReadLow: fileSize,
      networkReadHigh: fileSize,
      readOps: 1,
      precision: Precision.EXACT,
    })
  } catch {
    return new ProvisionResult({ command: 'jq' })
  }
}

async function readFile(accessor: RAMAccessor, p: PathSpec): Promise<Uint8Array> {
  return materialize(ramStream(accessor, p))
}

async function jqCommand(
  accessor: RAMAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const expression = texts[0]
  if (expression === undefined) {
    return [
      null,
      new IOResult({ exitCode: 1, stderr: ENC.encode('jq: usage: jq EXPRESSION [path]\n') }),
    ]
  }
  const { raw, compact, slurp, nullInput, evalFlags, rawfiles } = collectJqFlags(opts.flags)

  // Resolve --rawfile values through the owning VFS and lower each to
  // --arg name <contents> (jq's --rawfile binds the file's bytes as a
  // string, identical to --arg with those contents). jq-wasm cannot see the
  // mirage VFS, so the read must happen here via the resource accessor.
  for (const rf of rawfiles) {
    try {
      const spec = PathSpec.fromStrPath(rf.path, opts.mountPrefix ?? '')
      const bytes = await readFile(accessor, spec)
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
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    // The JSONL streaming fast-path evaluates per-line without the collected
    // flags; only take it when there are none.
    if (
      evalFlags.length === 0 &&
      isJsonlPath(first.original) &&
      isStreamableJsonlExpr(expression)
    ) {
      return [evalJsonlStream(ramStream(accessor, first), expression), new IOResult()]
    }
    const outputs: Uint8Array[] = []
    for (const p of paths) {
      const bytes = await readFile(accessor, p)
      let data = parseJsonPath(bytes, p.original)
      if (slurp) data = Array.isArray(data) ? data : [data]
      const result = await jqEval(data, expr, evalFlags)
      outputs.push(formatJqOutput(result, raw, compact, spread))
    }
    const out: ByteSource = concatBytes(outputs)
    return [out, new IOResult()]
  }

  const bytes = await readStdinAsync(opts.stdin)
  if (bytes === null) return [null, new IOResult()]
  let data = parseJsonAuto(bytes)
  if (slurp && !Array.isArray(data)) data = [data]
  const result = await jqEval(data, expr, evalFlags)
  return [formatJqOutput(result, raw, compact, spread), new IOResult()]
}

export const RAM_JQ = command({
  name: 'jq',
  resource: ResourceName.RAM,
  spec: specOf('jq'),
  fn: jqCommand,
  provision: jqProvision,
})
