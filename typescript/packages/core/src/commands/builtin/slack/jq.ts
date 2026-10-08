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

import type { SlackAccessor } from '../../../accessor/slack.ts'
import { runJq } from '../../../core/jq/run.ts'
import { resolveSlackGlob } from '../../../core/slack/glob.ts'
import { read as slackRead } from '../../../core/slack/read.ts'
import type { PathSpec } from '../../../types.ts'
import { ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'

async function jqCommand(
  accessor: SlackAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0 ? await resolveSlackGlob(accessor, paths, opts.index ?? undefined) : paths
  return runJq(resolved, texts, opts, (p) => slackRead(accessor, p, opts.index ?? undefined))
}

export const SLACK_JQ = command({
  name: 'jq',
  resource: ResourceName.SLACK,
  spec: specOf('jq'),
  fn: jqCommand,
})
