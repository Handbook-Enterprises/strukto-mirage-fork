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

import type { GSheetsAccessor } from '../../../accessor/gsheets.ts'
import { runJq } from '../../../core/jq/run.ts'
import { resolveGlob } from '../../../core/gsheets/glob.ts'
import { read as gsheetsRead } from '../../../core/gsheets/read.ts'
import type { PathSpec } from '../../../types.ts'
import { ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'

async function jqCommand(
  accessor: GSheetsAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : paths
  return runJq(resolved, texts, opts, (p) => gsheetsRead(accessor, p, opts.index ?? undefined))
}

export const GSHEETS_JQ = command({
  name: 'jq',
  resource: ResourceName.GSHEETS,
  spec: specOf('jq'),
  fn: jqCommand,
})
