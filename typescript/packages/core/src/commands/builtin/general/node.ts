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

import type { Accessor } from '../../../accessor/base.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { handleJs } from '../../../workspace/executor/js/handle.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

// What `node --version` reports when the injected runtime doesn't expose its
// own version. mirage's `node` is a QuickJS-class sandbox, not real Node, so
// a generic sandbox string is the honest answer.
const DEFAULT_RUNTIME_VERSION = 'v20.0.0-quickjs-sandbox'

// `node --version` / `node -v` must print a version and exit, NOT be resolved
// as a script path. Detect the flag as the first positional argument (a
// leading `/` may already have been prepended by an upstream resolver).
function isVersionArg(arg: string): boolean {
  const bare = arg.startsWith('/') ? arg.slice(1) : arg
  return bare === '--version' || bare === '-v'
}

function normalizePosix(p: string): string {
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return '/' + parts.join('/')
}

function resolveScript(name: string, cwd: string): PathSpec {
  const joined = name.startsWith('/') ? name : `${cwd.replace(/\/+$/, '')}/${name}`
  const path = normalizePosix(joined)
  const lastSlash = path.lastIndexOf('/')
  const directory = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '/'
  return new PathSpec({ original: path, directory, resolved: true })
}

async function nodeCommand(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const firstArg = paths[0]?.original ?? texts[0] ?? null
  if (firstArg !== null && isVersionArg(firstArg)) {
    const runtime = opts.jsRuntime
    const version =
      runtime?.version !== undefined ? await runtime.version() : DEFAULT_RUNTIME_VERSION
    return [ENC.encode(`${version}\n`), new IOResult({ exitCode: 0 })]
  }

  if (opts.execAllowed === false) {
    return [
      null,
      new IOResult({
        exitCode: 126,
        stderr: ENC.encode("node: root mount '/' is not in EXEC mode\n"),
      }),
    ]
  }

  if (opts.jsRuntime === undefined) {
    return [
      null,
      new IOResult({
        exitCode: 127,
        stderr: ENC.encode('node: js runtime is not available\n'),
      }),
    ]
  }

  if (opts.dispatch === undefined) {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: ENC.encode('node: no dispatch available\n'),
      }),
    ]
  }

  // Node's inline eval flags: `-e` / `--eval`.
  const eFlag = opts.flags.e
  const evalFlag = opts.flags.eval
  const code = typeof eFlag === 'string' ? eFlag : typeof evalFlag === 'string' ? evalFlag : null
  const hasCode = code !== null
  let scriptPath: PathSpec | null = null
  let argStrs: string[]
  // `-` is the conventional "read the program from stdin" sentinel (`echo … |
  // node -`), same as bare `node`. Treat it as no-script so it falls through to
  // the stdin-as-code branch below rather than being read as a file named `-`.
  if (hasCode) {
    argStrs = [...paths.map((p) => p.original), ...texts]
  } else if (paths.length > 0) {
    const first = paths[0] ?? null
    scriptPath = first !== null && first.original === '-' ? null : first
    argStrs = [...paths.slice(1).map((p) => p.original), ...texts]
  } else if (texts.length > 0) {
    scriptPath = texts[0] === '-' ? null : resolveScript(texts[0] ?? '', opts.cwd)
    argStrs = texts.slice(1)
  } else {
    argStrs = []
  }

  let resolvedCode: string | null = code
  let stdinForRuntime = opts.stdin
  if (resolvedCode === null && scriptPath === null && opts.stdin !== null) {
    const bytes = await materialize(opts.stdin)
    if (bytes.length > 0) {
      resolvedCode = DEC.decode(bytes)
      stdinForRuntime = null
    }
  }

  const [stdout, io] = await handleJs(
    opts.dispatch,
    scriptPath,
    argStrs,
    {
      stdin: stdinForRuntime,
      env: opts.env ?? {},
      code: resolvedCode,
    },
    { runtime: opts.jsRuntime },
  )
  return [stdout, io]
}

export const GENERAL_NODE = command({
  name: 'node',
  resource: null,
  spec: specOf('node'),
  fn: nodeCommand,
})

export const GENERAL_JS = command({
  name: 'js',
  resource: null,
  spec: specOf('js'),
  fn: nodeCommand,
})
