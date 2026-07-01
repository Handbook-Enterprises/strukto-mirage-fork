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

export interface JsRunArgs {
  code: string
  args: string[]
  env: Record<string, string>
  stdin: Uint8Array | null
}

export interface JsRunResult {
  stdout: Uint8Array
  stderr: Uint8Array
  exitCode: number
}

export interface JsReplRunArgs {
  code: string
  sessionId: string
}

export type JsReplStatus = 'complete' | 'incomplete' | 'exit'

export interface JsReplRunResult {
  stdout: Uint8Array
  stderr: Uint8Array
  exitCode: number
  status: JsReplStatus
}

/**
 * The JS runtime contract the Workspace drives, mirroring `PythonRuntime`.
 * There is no built-in default (unlike Pyodide for Python): a host must inject
 * one via `WorkspaceOptions.jsRuntimeFactory`, which receives an *enforced*
 * workspace bridge (node:fs) plus a `WorkspaceExecFn` (node:child_process).
 */
export interface JsRuntime {
  run(args: JsRunArgs): Promise<JsRunResult>
  runRepl(args: JsReplRunArgs): Promise<JsReplRunResult>
  addMount(prefix: string): Promise<void>
  removeMount(prefix: string): Promise<void>
  close(): Promise<void>
}

export class JsRuntimeUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'JsRuntimeUnavailableError'
  }
}
