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

// Regression for "ls notion" when cwd is '/' and no root mount is registered.
// The classifier needs to find the ls spec from any mount that owns the
// command (fallback when cwdMount is null), otherwise bare positional args
// like `notion` stay as strings, never become PathSpecs, and the dispatcher
// routes to the default RAM cache mount which throws "not a directory".

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SESSION_ID,
  makeWorkspace,
  stderrStr,
  stdoutStr,
} from './fixtures/workspace_fixture.ts'

describe('bare mount-root args when cwd=/ has no mount', () => {
  it('ls <mount> resolves the same as ls /<mount>', async () => {
    const { ws } = await makeWorkspace()
    ws.getSession(DEFAULT_SESSION_ID).cwd = '/'
    const bare = await ws.execute('ls s3')
    const absolute = await ws.execute('ls /s3')
    expect(stderrStr(bare)).not.toContain('not a directory')
    expect(stderrStr(bare)).toBe(stderrStr(absolute))
    expect(stdoutStr(bare)).toBe(stdoutStr(absolute))
    await ws.close()
  })

  it('cat <mount>/<file> resolves the same as cat /<mount>/<file>', async () => {
    const { ws } = await makeWorkspace()
    ws.getSession(DEFAULT_SESSION_ID).cwd = '/'
    const bare = await ws.execute('cat s3/data.txt')
    const absolute = await ws.execute('cat /s3/data.txt')
    expect(stdoutStr(bare)).toBe(stdoutStr(absolute))
    expect(stderrStr(bare)).toBe(stderrStr(absolute))
    await ws.close()
  })
})
