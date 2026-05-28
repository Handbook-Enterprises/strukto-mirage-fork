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

// End-to-end test for per-mount include/exclude path globs, exercised
// through a RAM mount + real `ls` / `find` / `cat` commands. The RAM
// readdir helper is wrapped by applyMountFilter like every other resource,
// so this proves the listing hook + the executor access guard together.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { RAMResource } from '../resource/ram/ram.ts'
import { createShellParser, type ShellParser } from '../shell/parse.ts'
import { MountMode } from '../types.ts'
import { Workspace } from './workspace.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

// Seed the RAM store via an UNFILTERED workspace, then hand the same
// RAMResource to a filtered workspace for the assertions. (Seeding through
// a filtered workspace would be denied by the access guard for writes to
// excluded paths — which is correct behaviour, just not what we want when
// setting up fixtures.)
async function seededRam(): Promise<RAMResource> {
  const ram = new RAMResource()
  const seedWs = new Workspace({ '/ram': ram }, { mode: MountMode.WRITE, shellParser: parser })
  await seedWs.execute('mkdir -p /ram/channels /ram/dms /ram/users')
  await seedWs.execute('echo hi > /ram/channels/general.txt')
  await seedWs.execute('echo secret > /ram/dms/alex.txt')
  await seedWs.execute('echo u > /ram/users/list.txt')
  await seedWs.execute('echo top > /ram/users.tsv')
  await seedWs.close()
  return ram
}

async function filteredWs(
  mountFilters?: Record<string, { includeGlobs?: string[]; excludeGlobs?: string[] }>,
): Promise<Workspace> {
  const ram = await seededRam()
  return new Workspace(
    { '/ram': ram },
    {
      mode: MountMode.WRITE,
      shellParser: parser,
      ...(mountFilters ? { mountFilters } : {}),
    },
  )
}

describe('mount path-glob filter (integration)', () => {
  it('with no filter, ls shows everything (baseline)', async () => {
    const ws = await filteredWs()
    const res = await ws.execute('ls /ram')
    const names = res.stdoutText.split('\n').filter(Boolean).sort()
    expect(names).toEqual(['channels', 'dms', 'users', 'users.tsv'])
    await ws.close()
  })

  it('excludeGlobs hides the matched dir from ls (X/** hides X)', async () => {
    const ws = await filteredWs({ '/ram': { excludeGlobs: ['dms/**'] } })
    const res = await ws.execute('ls /ram')
    const names = res.stdoutText.split('\n').filter(Boolean).sort()
    expect(names).toEqual(['channels', 'users', 'users.tsv'])
    expect(names).not.toContain('dms')
    await ws.close()
  })

  it('denies direct access to an excluded path (cat -> error)', async () => {
    const ws = await filteredWs({ '/ram': { excludeGlobs: ['dms/**'] } })
    const res = await ws.execute('cat /ram/dms/alex.txt')
    expect(res.exitCode).not.toBe(0)
    expect(res.stderrText).toMatch(/No such file or directory/)
    expect(res.stdoutText).toBe('')
    await ws.close()
  })

  it('denies listing the excluded dir itself (ls /ram/dms -> error)', async () => {
    const ws = await filteredWs({ '/ram': { excludeGlobs: ['dms/**'] } })
    const res = await ws.execute('ls /ram/dms')
    expect(res.exitCode).not.toBe(0)
    await ws.close()
  })

  // NOTE on recursive find / grep -r: every *remote* resource (slack,
  // gdrive, gmail, notion, …) recurses by calling its `readdir` helper,
  // which is wrapped by applyMountFilter — so excluded subtrees are never
  // descended into and never leak. RAM is the exception: its find/grep walk
  // the in-memory store directly rather than via readdir, so a root-level
  // `find /ram` is NOT filtered. We therefore test the access-guard
  // behaviour here (which RAM honours) and verify recursive filtering for a
  // readdir-backed resource live against the slack mount.
  it('denies find/grep that NAME an excluded path (access guard)', async () => {
    const ws = await filteredWs({ '/ram': { excludeGlobs: ['dms/**'] } })
    const findRes = await ws.execute('find /ram/dms')
    expect(findRes.exitCode).not.toBe(0)
    const grepRes = await ws.execute('grep -r secret /ram/dms')
    expect(grepRes.exitCode).not.toBe(0)
    await ws.close()
  })

  it('includeGlobs allowlist: only matched subtrees visible, ancestors stay listable', async () => {
    const ws = await filteredWs({ '/ram': { includeGlobs: ['channels/**', 'users.tsv'] } })
    const res = await ws.execute('ls /ram')
    const names = res.stdoutText.split('\n').filter(Boolean).sort()
    expect(names).toEqual(['channels', 'users.tsv'])
    await ws.close()
  })

  it('exclude wins over include', async () => {
    const ws = await filteredWs({
      '/ram': { includeGlobs: ['**'], excludeGlobs: ['dms/**'] },
    })
    const res = await ws.execute('ls /ram')
    const names = res.stdoutText.split('\n').filter(Boolean)
    expect(names).not.toContain('dms')
    expect(names).toContain('channels')
    await ws.close()
  })
})
