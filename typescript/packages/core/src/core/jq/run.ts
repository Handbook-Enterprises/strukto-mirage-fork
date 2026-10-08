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

import * as jqWasm from 'jq-wasm'
import { IOResult } from '../../io/types.ts'
import { PathSpec } from '../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../commands/config.ts'
import { readStdinAsync } from '../../commands/builtin/utils/stream.ts'
import { JQ_BOOL_FLAGS, JQ_UNSUPPORTED_FLAGS } from './flags.ts'

// Run real jq (jq-wasm) over the raw input bytes with the user's flags and
// return jq's own stdout, stderr and exit code. Backends only supply how a
// path is read. Earlier versions parsed the input into one JS value and
// re-shaped jq's results, which merged NDJSON input into an array and folded
// several outputs into one JSON array unless the filter text contained "[]".

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

type Flags = Record<string, string | boolean>

function key(flag: string): string {
  return flag.replace(/^-+/, '').replaceAll('-', '_')
}

function isOn(flags: Flags, f: { short?: string; long: string }): boolean {
  return (f.short !== undefined && flags[key(f.short)] === true) || flags[key(f.long)] === true
}

function stringFlag(flags: Flags, ...names: string[]): string | null {
  for (const name of names) {
    const value = flags[key(name)]
    if (typeof value === 'string') return value
  }
  return null
}

function decodeTuples(value: string | boolean | undefined): string[][] {
  if (typeof value !== 'string' || value === '') return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (t): t is string[] => Array.isArray(t) && t.every((v) => typeof v === 'string'),
    )
  } catch {
    return []
  }
}

function resolveAgainst(cwd: string, path: string): string {
  const joined = path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${path}`
  const out: string[] = []
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

/**
 * Every file a jq invocation reads besides the filter: input operands
 * (including the TEXT positional, which is an input file under -f) and the
 * --rawfile / --slurpfile files. Exported so hosts can measure or pre-route
 * the exact set of files jq will read.
 */
export function jqReadPaths(
  paths: readonly PathSpec[],
  texts: readonly string[],
  opts: Pick<CommandOpts, 'flags' | 'cwd' | 'mountPrefix'>,
): { inputs: PathSpec[]; variables: PathSpec[] } {
  const prefix = opts.mountPrefix ?? ''
  const fromFile = stringFlag(opts.flags, '-f', '--from-file') !== null
  const extra = fromFile
    ? texts.map((t) => PathSpec.fromStrPath(resolveAgainst(opts.cwd, t), prefix))
    : []
  const variables = [...decodeTuples(opts.flags.rawfile), ...decodeTuples(opts.flags.slurpfile)]
    .map((t) => t[1])
    .filter((p): p is string => p !== undefined)
    .map((p) => PathSpec.fromStrPath(p, prefix))
  return { inputs: [...extra, ...paths], variables }
}

class JqReadError extends Error {}

function isJsonl(path: PathSpec): boolean {
  return path.original.endsWith('.jsonl') || path.original.endsWith('.ndjson')
}

function fail(stderr: string, exitCode: number): CommandFnResult {
  return [null, new IOResult({ exitCode, stderr: ENC.encode(stderr) })]
}

export type JqPathReader = (path: PathSpec) => Promise<Uint8Array>

/**
 * The jq command body shared by every backend. `read` returns a file's bytes
 * through the owning resource; `paths` are already glob-expanded.
 */
export async function runJq(
  paths: readonly PathSpec[],
  texts: readonly string[],
  opts: CommandOpts,
  read: JqPathReader,
): Promise<CommandFnResult> {
  const flags = opts.flags
  for (const f of JQ_UNSUPPORTED_FLAGS) {
    const used =
      isOn(flags, f) ||
      [f.short, f.long].some((n) => n !== undefined && flags[key(n)] !== undefined)
    if (used) return fail(`jq: ${f.long} is not supported here; ${f.hint}\n`, 2)
  }

  const readText = async (p: PathSpec): Promise<string> => {
    try {
      return DEC.decode(await read(p))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new JqReadError(`jq: error: Could not open ${p.original}: ${msg}\n`)
    }
  }

  const jqFlags: string[] = []
  for (const f of JQ_BOOL_FLAGS) if (f.pass !== null && isOn(flags, f)) jqFlags.push(f.pass)
  const indent = stringFlag(flags, '--indent')
  if (indent !== null) jqFlags.push('--indent', indent)
  for (const [name = '', value = ''] of decodeTuples(flags.arg)) jqFlags.push('--arg', name, value)
  for (const [name = '', value = ''] of decodeTuples(flags.argjson)) {
    jqFlags.push('--argjson', name, value)
  }

  const prefix = opts.mountPrefix ?? ''
  try {
    // jq-wasm has no filesystem: file-backed variables are read through the
    // VFS and passed as the equivalent --arg / --argjson.
    for (const [name = '', path] of decodeTuples(flags.rawfile)) {
      if (path === undefined) continue
      jqFlags.push('--arg', name, await readText(PathSpec.fromStrPath(path, prefix)))
    }
    for (const [name = '', path] of decodeTuples(flags.slurpfile)) {
      if (path === undefined) continue
      const text = await readText(PathSpec.fromStrPath(path, prefix))
      const slurped = await jqWasm.raw(text, '.', ['-c', '-s'])
      if (slurped.exitCode !== 0) return fail(withNewline(slurped.stderr), 2)
      jqFlags.push('--argjson', name, slurped.stdout.trim())
    }

    const fromFile = stringFlag(flags, '-f', '--from-file')
    const filter =
      fromFile !== null ? await readText(PathSpec.fromStrPath(fromFile, prefix)) : texts[0]
    if (filter === undefined) return fail('Usage: jq [OPTIONS] FILTER [FILES...]\n', 2)
    const inputs = jqReadPaths(paths, texts, opts).inputs

    // Each run is one jq process over one input stream.
    const runs: { input: string; extra: string[] }[] = []
    const nullInput = jqFlags.includes('-n')
    if (nullInput || inputs.length === 0) {
      const stdin = nullInput ? null : await readStdinAsync(opts.stdin)
      runs.push({ input: stdin === null ? '' : DEC.decode(stdin), extra: [] })
    } else if (jqFlags.includes('-s')) {
      // jq slurps every input file into one array.
      const parts: string[] = []
      for (const p of inputs) parts.push(await readText(p))
      runs.push({ input: parts.join('\n'), extra: [] })
    } else {
      for (const p of inputs) {
        // Established mirage behavior: a .jsonl/.ndjson file operand is one
        // array of its records, so `jq length f.jsonl` counts rows and
        // `jq '.[] | .x' f.jsonl` iterates them. Piped NDJSON stays plain jq.
        const asArray = isJsonl(p) && !jqFlags.includes('-R')
        runs.push({ input: await readText(p), extra: asArray ? ['-s'] : [] })
      }
    }

    const joined = jqFlags.includes('-j') || jqFlags.includes('--raw-output0')
    let stdout = ''
    let stderr = ''
    // jq's status: an error (>= 2) wins; otherwise, under -e, the status of
    // the last output, which belongs to the last run.
    let errorCode = 0
    let lastCode = 0
    for (const run of runs) {
      const result = await jqWasm.raw(run.input, filter, [...jqFlags, ...run.extra])
      // Upstream jq-wasm trims stdout, which loses real leading/trailing
      // whitespace of raw output; hosts should carry a jq-wasm patch that
      // removes the trim (see ve-brain's patches/jq-wasm). This only restores
      // the trailing newline jq would have printed.
      stdout += joined ? result.stdout : withNewline(result.stdout)
      stderr += withNewline(result.stderr)
      if (result.exitCode >= 2) errorCode = Math.max(errorCode, result.exitCode)
      else lastCode = result.exitCode
      // A compile error repeats identically for every file.
      if (result.exitCode === 3) break
    }
    const exitCode = errorCode !== 0 ? errorCode : lastCode
    return [ENC.encode(stdout), new IOResult({ exitCode, stderr: ENC.encode(stderr) })]
  } catch (err) {
    if (err instanceof JqReadError) return fail(err.message, 2)
    throw err
  }
}

function withNewline(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`
}
