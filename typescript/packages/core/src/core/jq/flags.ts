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
