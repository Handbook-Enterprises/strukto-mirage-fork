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

export interface JqRawfileSpec {
  name: string
  path: string
}

export interface JqFlags {
  raw: boolean
  compact: boolean
  slurp: boolean
  nullInput: boolean
  // Eval-affecting flags for jq-wasm (`-n`, `--arg name value`,
  // `--argjson name json`). `--rawfile` is resolved by the caller against the
  // owning VFS and appended as `--arg name <contents>`.
  evalFlags: string[]
  rawfiles: JqRawfileSpec[]
}

function decodeTuples(value: string | boolean | undefined): string[][] {
  if (typeof value !== 'string' || value === '') return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((t): t is string[] => Array.isArray(t))
  } catch {
    return []
  }
}

export function collectJqFlags(flags: Record<string, string | boolean>): JqFlags {
  const raw = flags.r === true || flags.raw_output === true
  const compact = flags.c === true || flags.compact_output === true
  const slurp = flags.s === true || flags.slurp === true
  const nullInput = flags.n === true || flags.null_input === true

  const evalFlags: string[] = []
  if (nullInput) evalFlags.push('-n')
  for (const tuple of decodeTuples(flags.arg)) {
    const [name, val] = tuple
    if (name !== undefined && val !== undefined) evalFlags.push('--arg', name, val)
  }
  for (const tuple of decodeTuples(flags.argjson)) {
    const [name, val] = tuple
    if (name !== undefined && val !== undefined) evalFlags.push('--argjson', name, val)
  }

  const rawfiles: JqRawfileSpec[] = []
  for (const tuple of decodeTuples(flags.rawfile)) {
    const [name, path] = tuple
    if (name !== undefined && path !== undefined) rawfiles.push({ name, path })
  }

  return { raw, compact, slurp, nullInput, evalFlags, rawfiles }
}

// Every jq 1.8.1 option mirage accepts. The jq spec (commands/spec/builtins.ts)
// and runJq (run.ts) are both built from this table, so a flag cannot be
// parsed without being forwarded, or forwarded without being parsed.
export interface JqBoolFlag {
  short?: string
  long: string
  description: string
  // Forwarded to jq; null means accepted and ignored (terminal-only).
  pass: string | null
}

export const JQ_BOOL_FLAGS: readonly JqBoolFlag[] = [
  { short: '-r', long: '--raw-output', pass: '-r', description: 'Output strings without quotes.' },
  { short: '-j', long: '--join-output', pass: '-j', description: 'Like -r, without newlines.' },
  { long: '--raw-output0', pass: '--raw-output0', description: 'Like -r, NUL after each output.' },
  { short: '-a', long: '--ascii-output', pass: '-a', description: 'Escape non-ASCII characters.' },
  { short: '-c', long: '--compact-output', pass: '-c', description: 'Compact JSON output.' },
  { short: '-s', long: '--slurp', pass: '-s', description: 'Read all inputs into one array.' },
  {
    short: '-n',
    long: '--null-input',
    pass: '-n',
    description: "Use null as the single input value; don't read input.",
  },
  { short: '-R', long: '--raw-input', pass: '-R', description: 'Read each line as a string.' },
  {
    short: '-e',
    long: '--exit-status',
    pass: '-e',
    description: 'Exit 1 if the last output is false or null, 4 if there was none.',
  },
  { short: '-S', long: '--sort-keys', pass: '-S', description: 'Sort object keys.' },
  { long: '--tab', pass: '--tab', description: 'Indent with tabs.' },
  { long: '--seq', pass: '--seq', description: 'Use application/json-seq framing.' },
  { long: '--stream', pass: '--stream', description: 'Emit [path, leaf] events.' },
  { long: '--stream-errors', pass: '--stream-errors', description: 'Like --stream, plus errors.' },
  {
    short: '-C',
    long: '--color-output',
    pass: null,
    description: 'Ignored: output is never colored.',
  },
  {
    short: '-M',
    long: '--monochrome-output',
    pass: null,
    description: 'Ignored: output is never colored.',
  },
  { long: '--unbuffered', pass: null, description: 'Ignored.' },
]

// $ARGS positional modes: jq-wasm always appends its input file after the
// filter, so these cannot be forwarded faithfully. Reject instead of misreading.
export const JQ_UNSUPPORTED_FLAGS: readonly { long: string; hint: string }[] = [
  { long: '--args', hint: 'use --arg name value' },
  { long: '--jsonargs', hint: 'use --argjson name json' },
]
