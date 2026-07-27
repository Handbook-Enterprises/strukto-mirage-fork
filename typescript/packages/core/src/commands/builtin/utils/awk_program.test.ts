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
import { validateAwkProgram } from './awk_program.ts'

describe('validateAwkProgram — supported subset passes', () => {
  const ok = [
    '{print $2}',
    '{print $1, $2}',
    '{print}',
    '{print "total:", $1}',
    '{sum += $1} END {print sum}',
    'NR>1{s+=$2}END{print s}',
    '$1 == "foo" {print $2}',
    '/error/ {print $1}',
    '/pattern/',
    'NR > 5',
  ]
  for (const program of ok) {
    it(`accepts ${program}`, () => {
      expect(validateAwkProgram(program)).toBeNull()
    })
  }
})

describe('validateAwkProgram — unsupported syntax fails loudly', () => {
  const cases: [string, string][] = [
    // The killer: arithmetic expression in a print, previously emitted as
    // literal program text with exit 0.
    [
      '{rows+=1; clicks+=$2; weighted_position+=$3} END {print rows, clicks, weighted_position / impressions}',
      'weighted_position / impressions',
    ],
    ['END {print a / b}', 'a / b'],
    ['{print $1 + $2}', '$1 + $2'],
    ['BEGIN {FS=","} {print $1}', 'BEGIN block'],
    ['$1 > 0 && $2 < 10 {print $1}', 'compound condition'],
    ['function f(x) { return x } {print f($1)}', 'function definitions'],
    ['{printf "%d\\n", $1}', 'printf'],
    ['{count++} END {print count}', 'count++'],
    ['{n = n + 1} END {print n}', 'n = n + 1'],
    ['{sum -= $1} END {print sum}', 'sum -= $1'],
    ['length($0) > 5 {print}', 'length($0) > 5'],
  ]
  for (const [program, needle] of cases) {
    it(`rejects ${program}`, () => {
      const err = validateAwkProgram(program)
      expect(err).not.toBeNull()
      expect(err).toContain('awk: unsupported syntax:')
      expect(err).toContain(needle)
      expect(err).toContain(
        '(supported: field prints, regex conditions, sum accumulators, simple END prints)',
      )
    })
  }
})
