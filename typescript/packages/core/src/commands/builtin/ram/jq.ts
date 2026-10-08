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
import { isJsonlPath, isStreamableJsonlExpr } from '../../../core/jq/index.ts'
import { runJq } from '../../../core/jq/run.ts'
import { Precision, ProvisionResult } from '../../../provision/types.ts'
import { materialize } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'

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
  return runJq(paths, texts, opts, (p) => readFile(accessor, p))
}

export const RAM_JQ = command({
  name: 'jq',
  resource: ResourceName.RAM,
  spec: specOf('jq'),
  fn: jqCommand,
  provision: jqProvision,
})
