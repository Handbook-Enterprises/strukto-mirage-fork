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

export const OperandKind = Object.freeze({
  NONE: 'none',
  PATH: 'path',
  TEXT: 'text',
} as const)

export type OperandKind = (typeof OperandKind)[keyof typeof OperandKind]

export interface OptionInit {
  short?: string | null
  long?: string | null
  valueKind?: OperandKind
  numericShorthand?: boolean
  description?: string
  arity?: number
  tuplePathIndices?: readonly number[]
}

export class Option {
  readonly short: string | null
  readonly long: string | null
  readonly valueKind: OperandKind
  readonly numericShorthand: boolean
  readonly description: string | null
  // Number of values this option consumes per occurrence. Options with
  // arity > 1 are repeatable and collected as a JSON-encoded list of
  // value-tuples under the flag's key (e.g. jq's `--arg name value`), since
  // the flat flags record cannot hold a list of tuples directly.
  readonly arity: number
  // Which value positions within each tuple are filesystem paths (resolved
  // against cwd and surfaced in routingPaths), e.g. `--rawfile name file`
  // has its second value (index 1) as a path.
  readonly tuplePathIndices: readonly number[]

  constructor(init: OptionInit = {}) {
    this.short = init.short ?? null
    this.long = init.long ?? null
    this.valueKind = init.valueKind ?? OperandKind.NONE
    this.numericShorthand = init.numericShorthand ?? false
    this.description = init.description ?? null
    this.arity = init.arity ?? 1
    this.tuplePathIndices = init.tuplePathIndices ?? []
    Object.freeze(this)
  }
}

export interface OperandInit {
  kind?: OperandKind
}

export class Operand {
  readonly kind: OperandKind

  constructor(init: OperandInit = {}) {
    this.kind = init.kind ?? OperandKind.PATH
    Object.freeze(this)
  }
}

export interface CommandSpecInit {
  options?: readonly Option[]
  positional?: readonly Operand[]
  rest?: Operand | null
  ignoreTokens?: readonly string[]
  description?: string
}

export class CommandSpec {
  readonly options: readonly Option[]
  readonly positional: readonly Operand[]
  readonly rest: Operand | null
  readonly ignoreTokens: ReadonlySet<string>
  readonly description: string | null

  constructor(init: CommandSpecInit = {}) {
    this.options = init.options ?? []
    this.positional = init.positional ?? []
    this.rest = init.rest ?? null
    this.ignoreTokens = new Set(init.ignoreTokens ?? [])
    this.description = init.description ?? null
    Object.freeze(this)
  }
}

export interface ParsedArgsInit {
  flags: Record<string, string | boolean>
  args: [string, OperandKind][]
  cachePaths?: string[]
  pathFlagValues?: string[]
}

export class ParsedArgs {
  readonly flags: Record<string, string | boolean>
  readonly args: [string, OperandKind][]
  readonly cachePaths: string[]
  readonly pathFlagValues: string[]

  constructor(init: ParsedArgsInit) {
    this.flags = init.flags
    this.args = init.args
    this.cachePaths = init.cachePaths ?? []
    this.pathFlagValues = init.pathFlagValues ?? []
  }

  paths(): string[] {
    return this.args.filter(([, k]) => k === OperandKind.PATH).map(([v]) => v)
  }

  routingPaths(): string[] {
    return [...this.paths(), ...this.pathFlagValues]
  }

  texts(): string[] {
    return this.args.filter(([, k]) => k === OperandKind.TEXT).map(([v]) => v)
  }

  flag(name: string, fallback: string | boolean | null = null): string | boolean | null {
    return this.flags[name] ?? fallback
  }
}
