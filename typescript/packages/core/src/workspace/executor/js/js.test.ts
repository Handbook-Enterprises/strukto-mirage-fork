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
import { OpsRegistry } from '../../../ops/registry.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { MountMode } from '../../../types.ts'
import { getTestParser, stderrStr, stdoutStr } from '../../fixtures/workspace_fixture.ts'
import { Workspace, type WorkspaceExecFn } from '../../workspace.ts'
import type { BridgeDispatchFn } from '../python/mirage_bridge.ts'
import type { JsRunArgs, JsRunResult, JsRuntime } from './types.ts'

const ENC = new TextEncoder()

// A tiny fake JsRuntime that interprets `code` as `OP arg1 arg2 ...` and drives
// the injected bridge / exec so tests can assert the real enforced plumbing
// without a real JS engine.
function makeFakeRuntime(bridge: BridgeDispatchFn, exec: WorkspaceExecFn): JsRuntime {
  const ok = (s: string | Uint8Array): JsRunResult => ({
    stdout: typeof s === 'string' ? ENC.encode(s) : s,
    stderr: new Uint8Array(),
    exitCode: 0,
  })
  const fail = (msg: string): JsRunResult => ({
    stdout: new Uint8Array(),
    stderr: ENC.encode(msg),
    exitCode: 1,
  })
  return {
    async run(args: JsRunArgs): Promise<JsRunResult> {
      const [op, ...rest] = args.code.trim().split(/\s+/)
      try {
        switch (op) {
          case 'ECHO':
            return ok(rest.join(' '))
          case 'WRITE':
            await bridge('WRITE', rest[0] ?? '', ENC.encode(rest.slice(1).join(' ')))
            return ok('ok')
          case 'READ':
            return ok((await bridge('READ', rest[0] ?? '')) as Uint8Array)
          case 'LIST': {
            const list = (await bridge('LIST', rest[0] ?? '')) as { path: string }[]
            return ok(JSON.stringify(list.map((e) => e.path)))
          }
          case 'EXISTS':
            return ok(String(await bridge('EXISTS', rest[0] ?? '')))
          case 'MKDIR':
            await bridge('MKDIR', rest[0] ?? '')
            return ok('ok')
          case 'DELETE':
            await bridge('DELETE', rest[0] ?? '')
            return ok('ok')
          case 'RENAME':
            await bridge('RENAME', rest[0] ?? '', ENC.encode(rest[1] ?? ''))
            return ok('ok')
          case 'EXEC': {
            const r = await exec(rest.join(' '))
            return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }
          }
          case 'SCRIPTINFO':
            return ok(
              JSON.stringify({
                scriptPath: args.scriptPath ?? null,
                scriptDir: args.scriptDir ?? null,
              }),
            )
          default:
            return fail(`unknown op ${String(op)}\n`)
        }
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    },
    runRepl() {
      return Promise.resolve({
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        exitCode: 0,
        status: 'complete' as const,
      })
    },
    addMount() {
      return Promise.resolve()
    },
    removeMount() {
      return Promise.resolve()
    },
    close() {
      return Promise.resolve()
    },
  }
}

async function makeJsWorkspace(withRuntime = true): Promise<Workspace> {
  const parser = await getTestParser()
  const ram = new RAMResource()
  const ro = new RAMResource()
  const registry = new OpsRegistry()
  registry.registerResource(ram)
  registry.registerResource(ro)
  return new Workspace(
    { '/ram': ram, '/ro': ro },
    {
      mode: MountMode.EXEC,
      modeOverrides: { '/ro': MountMode.READ },
      ops: registry,
      shellParser: parser,
      ...(withRuntime ? { jsRuntimeFactory: makeFakeRuntime } : {}),
    },
  )
}

describe('node/js runtime injection', () => {
  it('dispatches `node -e` to the injected runtime and returns stdout', async () => {
    const ws = await makeJsWorkspace()
    const io = await ws.execute("node -e 'ECHO hi there'")
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('hi there')
    await ws.close()
  })

  it('the `js` alias works too', async () => {
    const ws = await makeJsWorkspace()
    const io = await ws.execute("js -e 'ECHO viajs'")
    expect(stdoutStr(io)).toBe('viajs')
    await ws.close()
  })

  it('forwards the entry script path + directory to the runtime', async () => {
    const ws = await makeJsWorkspace()
    await ws.execute('printf SCRIPTINFO > /ram/main.js')
    const io = await ws.execute('node /ram/main.js')
    expect(io.exitCode).toBe(0)
    expect(JSON.parse(stdoutStr(io))).toEqual({ scriptPath: '/ram/main.js', scriptDir: '/ram/' })
    await ws.close()
  })

  it('leaves scriptPath/scriptDir undefined for `-e` and stdin', async () => {
    const ws = await makeJsWorkspace()
    const e = await ws.execute("node -e 'SCRIPTINFO'")
    expect(JSON.parse(stdoutStr(e))).toEqual({ scriptPath: null, scriptDir: null })
    const s = await ws.execute('printf SCRIPTINFO | node -')
    expect(JSON.parse(stdoutStr(s))).toEqual({ scriptPath: null, scriptDir: null })
    await ws.close()
  })

  it('reads the program from stdin when the script arg is `-` (echo … | node -)', async () => {
    const ws = await makeJsWorkspace()
    const io = await ws.execute('echo "ECHO from-stdin" | node -')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('from-stdin')
    await ws.close()
  })

  it('the `js -` alias reads stdin too', async () => {
    const ws = await makeJsWorkspace()
    const io = await ws.execute('echo "ECHO viajsdash" | js -')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('viajsdash')
    await ws.close()
  })

  it('`node -` with no stdin reports "no input" rather than reading a file named -', async () => {
    const ws = await makeJsWorkspace()
    const io = await ws.execute('node -')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toMatch(/no input/)
    await ws.close()
  })

  it('bridge WRITE + READ hit the real workspace filesystem', async () => {
    const ws = await makeJsWorkspace()
    const w = await ws.execute("node -e 'WRITE /ram/out.txt hello'")
    expect(w.exitCode).toBe(0)
    // Read back through the runtime bridge...
    const r = await ws.execute("node -e 'READ /ram/out.txt'")
    expect(stdoutStr(r)).toBe('hello')
    // ...and through the plain shell, proving it landed in the workspace.
    const cat = await ws.execute('cat /ram/out.txt')
    expect(stdoutStr(cat)).toBe('hello')
    await ws.close()
  })

  it('enforces mount modes — a bridge WRITE to a read-only mount fails', async () => {
    const ws = await makeJsWorkspace()
    const io = await ws.execute("node -e 'WRITE /ro/x.txt nope'")
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toMatch(/read-only/)
    const exists = await ws.execute("node -e 'EXISTS /ro/x.txt'")
    expect(stdoutStr(exists)).toBe('false')
    await ws.close()
  })

  it('LIST reflects real workspace entries', async () => {
    const ws = await makeJsWorkspace()
    await ws.execute("node -e 'WRITE /ram/a.txt 1'")
    await ws.execute("node -e 'WRITE /ram/b.txt 2'")
    const io = await ws.execute("node -e 'LIST /ram/'")
    const paths = JSON.parse(stdoutStr(io)) as string[]
    expect(paths).toEqual(expect.arrayContaining(['/ram/a.txt', '/ram/b.txt']))
    await ws.close()
  })

  it('child_process exec channel runs real shell commands', async () => {
    const ws = await makeJsWorkspace()
    const io = await ws.execute("node -e 'EXEC echo hello'")
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('hello\n')
    await ws.close()
  })

  it('enforced bridge hides filter-excluded entries and normalizes `..` (Copilot review)', async () => {
    const parser = await getTestParser()
    const ram = new RAMResource()
    const registry = new OpsRegistry()
    registry.registerResource(ram)
    // Seed a visible file and a filter-excluded one directly on the store.
    ram.store.files.set('/shown.txt', ENC.encode('ok'))
    ram.store.files.set('/hidden.secret', ENC.encode('sshh'))
    const ws = new Workspace(
      { '/ram': ram },
      {
        mode: MountMode.EXEC,
        ops: registry,
        shellParser: parser,
        mountFilters: { '/ram': { excludeGlobs: ['*.secret'] } },
        jsRuntimeFactory: makeFakeRuntime,
      },
    )
    // LIST does not leak the excluded child.
    const list = await ws.execute("node -e 'LIST /ram/'")
    const paths = JSON.parse(stdoutStr(list)) as string[]
    expect(paths).toContain('/ram/shown.txt')
    expect(paths).not.toContain('/ram/hidden.secret')
    // Direct READ of an excluded path is denied.
    const read = await ws.execute("node -e 'READ /ram/hidden.secret'")
    expect(read.exitCode).toBe(1)
    expect(stderrStr(read)).toMatch(/No such file/)
    // EXISTS stays total: a hidden path reads as `false`, not a thrown error.
    const exists = await ws.execute("node -e 'EXISTS /ram/hidden.secret'")
    expect(exists.exitCode).toBe(0)
    expect(stdoutStr(exists)).toBe('false')
    // `..` can't be used to dodge the visibility check (normalized first).
    const dodge = await ws.execute("node -e 'READ /ram/sub/../hidden.secret'")
    expect(dodge.exitCode).toBe(1)
    expect(stderrStr(dodge)).toMatch(/No such file/)
    await ws.close()
  })

  it('is injection-only: no runtime → node reports unavailable (exit 127)', async () => {
    const ws = await makeJsWorkspace(false)
    const io = await ws.execute("node -e 'ECHO x'")
    expect(io.exitCode).toBe(127)
    expect(stderrStr(io)).toMatch(/js runtime is not available/)
    await ws.close()
  })

  it('`node --version` prints the sandbox runtime version, not a script-path error', async () => {
    const ws = await makeJsWorkspace()
    const io = await ws.execute('node --version')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io).trim()).toBe('v20.0.0-quickjs-sandbox')
    expect(stderrStr(io)).not.toMatch(/No such file/)
    await ws.close()
  })

  it('`node -v` behaves like `--version`', async () => {
    const ws = await makeJsWorkspace()
    const io = await ws.execute('node -v')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io).trim()).toBe('v20.0.0-quickjs-sandbox')
    await ws.close()
  })

  it('`--version` works even with no injected runtime (exit 0, not 127)', async () => {
    const ws = await makeJsWorkspace(false)
    const io = await ws.execute('node --version')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io).trim()).toBe('v20.0.0-quickjs-sandbox')
    await ws.close()
  })

  it('delegates to the runtime version() when the injected runtime exposes one', async () => {
    const parser = await getTestParser()
    const ram = new RAMResource()
    const registry = new OpsRegistry()
    registry.registerResource(ram)
    const ws = new Workspace(
      { '/ram': ram },
      {
        mode: MountMode.EXEC,
        ops: registry,
        shellParser: parser,
        jsRuntimeFactory: (bridge, exec) => {
          const base = makeFakeRuntime(bridge, exec)
          return { ...base, version: () => 'v42.7.0-custom' }
        },
      },
    )
    const io = await ws.execute('node --version')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io).trim()).toBe('v42.7.0-custom')
    await ws.close()
  })
})
