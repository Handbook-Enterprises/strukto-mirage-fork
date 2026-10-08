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

import { describe, expect, it } from 'vitest'
import { makeWorkspace, stderrStr, stdoutStr } from './fixtures/workspace_fixture.ts'

describe('workspace: a failed glob fails only its own command', () => {
  it('keeps earlier output and runs later commands after ;', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('echo before; cat /ram/zzz*.txt; echo after')
    expect(stdoutStr(io)).toBe('before\nafter\n')
    expect(stderrStr(io)).toContain("glob: no matches for pattern '/ram/zzz*.txt'")
    expect(io.exitCode).toBe(0)
    await ws.close()
  })

  it('stops an && chain with exit 1, like bash failglob', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('echo before && cat /ram/zzz*.txt && echo after')
    expect(stdoutStr(io)).toBe('before\n')
    expect(io.exitCode).toBe(1)
    await ws.close()
  })

  it('fails a for loop over an unmatched pattern without aborting the script', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('for f in /ram/zzz*.txt; do echo $f; done; echo after')
    expect(stdoutStr(io)).toBe('after\n')
    expect(stderrStr(io)).toContain('glob: no matches')
    await ws.close()
  })

  it('fails a pattern on an unmounted path without aborting the script', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute(
      'echo before; cat /nomount/zzz*.txt; for f in /nomount/*.txt; do echo $f; done; echo after',
    )
    expect(stdoutStr(io)).toBe('before\nafter\n')
    expect(stderrStr(io)).toContain('glob:')
    await ws.close()
  })
})
