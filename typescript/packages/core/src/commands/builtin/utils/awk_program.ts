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

const SUPPORTED_HINT =
  '(supported: field prints, regex conditions, sum accumulators, simple END prints)'

function unsupported(construct: string): string {
  return `awk: unsupported syntax: ${construct} ${SUPPORTED_HINT}`
}

function isSimpleOperand(tok: string): boolean {
  if (/^\$\d+$/.test(tok)) return true
  if (tok === 'NR' || tok === 'NF') return true
  if (/^-?\d+(\.\d+)?$/.test(tok)) return true
  if (/^[A-Za-z_]\w*$/.test(tok)) return true
  return false
}

function isSimplePrintArg(tok: string): boolean {
  if (/^"[^"]*"$/.test(tok)) return true
  return isSimpleOperand(tok)
}

function validatePrintArgs(args: string): string | null {
  const rest = args.trim()
  if (rest === '') return null
  for (const raw of rest.split(/,\s*/)) {
    const tok = raw.trim()
    if (tok === '') continue
    if (!isSimplePrintArg(tok)) return unsupported(tok)
  }
  return null
}

function validateStatements(action: string, ctx: 'main' | 'end'): string | null {
  for (const rawStmt of action.split(';')) {
    const stmt = rawStmt.trim()
    if (stmt === '') continue
    if (stmt.startsWith('printf')) return unsupported('printf')
    if (stmt.startsWith('print')) {
      const err = validatePrintArgs(stmt.slice('print'.length))
      if (err !== null) return err
      continue
    }
    const acc = /^([A-Za-z_]\w*)\s*\+=\s*(.+)$/.exec(stmt)
    if (acc !== null) {
      if (ctx === 'end') return unsupported('accumulator in END block')
      const rhs = (acc[2] ?? '').trim()
      if (!isSimpleOperand(rhs)) return unsupported(stmt)
      continue
    }
    return unsupported(stmt)
  }
  return null
}

function validateCondition(cond: string): string | null {
  const c = cond.trim()
  if (c === '') return null
  if (/&&|\|\|/.test(c)) return unsupported('compound condition')
  if (c.startsWith('/') && c.endsWith('/') && c.length >= 2) return null
  const cmp = /^(\$\d+|NR|NF)\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(c)
  if (cmp !== null) {
    const rhs = (cmp[3] ?? '').trim()
    if (rhs.includes('(')) return unsupported(c)
    return null
  }
  return unsupported(c)
}

function validateMain(main: string): string | null {
  const m = main.trim()
  if (m === '') return null
  if (/\b(BEGIN|END)\b/.test(m)) return unsupported('multiple BEGIN/END blocks')
  const braceCount = (m.match(/\{/g) ?? []).length
  if (braceCount > 1) return unsupported('multiple pattern-action rules')
  if (braceCount === 0) return validateCondition(m)
  const idx = m.indexOf('{')
  const condition = m.slice(0, idx).trim()
  const action = m
    .slice(idx + 1)
    .replace(/\}\s*$/, '')
    .trim()
  const condErr = validateCondition(condition)
  if (condErr !== null) return condErr
  return validateStatements(action, 'main')
}

export function validateAwkProgram(program: string): string | null {
  const trimmed = program.trim()
  if (trimmed === '') return null
  if (/\bfunction\b/.test(trimmed)) return unsupported('function definitions')

  let rest = trimmed
  const beginMatch = /^BEGIN\s*\{([^}]*)\}\s*([\s\S]*)$/.exec(rest)
  if (beginMatch !== null) {
    const beginBody = (beginMatch[1] ?? '').trim()
    if (beginBody !== '') return unsupported('BEGIN block')
    rest = (beginMatch[2] ?? '').trim()
  }

  let endBody: string | null = null
  const endMatch = /END\s*\{([^}]*)\}\s*$/.exec(rest)
  if (endMatch !== null) {
    endBody = (endMatch[1] ?? '').trim()
    rest = rest.slice(0, endMatch.index).trim()
  }

  const mainErr = validateMain(rest)
  if (mainErr !== null) return mainErr

  if (endBody !== null) {
    const endErr = validateStatements(endBody, 'end')
    if (endErr !== null) return endErr
  }

  return null
}
