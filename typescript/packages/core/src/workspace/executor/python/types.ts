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

export interface PythonRunArgs {
  code: string
  args: string[]
  env: Record<string, string>
  stdin: Uint8Array | null
  /**
   * Absolute directory of the entry script (Python's `sys.path[0]` analogue),
   * or undefined for `python -c` / stdin programs. A runtime that resolves
   * sibling modules from the workspace (e.g. a cf-monty import bundler) roots
   * its lookups here. Optional and ignored by runtimes that don't need it.
   */
  scriptDir?: string | undefined
  /** The shell's current working directory at invocation, when known. */
  cwd?: string | undefined
}

export interface PythonRunResult {
  stdout: Uint8Array
  stderr: Uint8Array
  exitCode: number
}

export interface PythonReplRunArgs {
  code: string
  sessionId: string
}

export type ReplStatus = 'complete' | 'incomplete' | 'exit'

export interface PythonReplRunResult {
  stdout: Uint8Array
  stderr: Uint8Array
  exitCode: number
  status: ReplStatus
}

/**
 * The python runtime contract the Workspace drives. `PyodideRuntime` implements
 * it structurally; a host may inject an alternative (e.g. a wasm interpreter)
 * via `WorkspaceOptions.pythonRuntimeFactory`.
 */
export interface PythonRuntime {
  run(args: PythonRunArgs): Promise<PythonRunResult>
  runRepl(args: PythonReplRunArgs): Promise<PythonReplRunResult>
  addMount(prefix: string): Promise<void>
  removeMount(prefix: string): Promise<void>
  close(): Promise<void>
}

export class PyodideUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PyodideUnavailableError'
  }
}
