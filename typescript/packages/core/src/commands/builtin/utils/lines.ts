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

/**
 * Join output lines the way coreutils print them: every line ends with a
 * newline, and no lines means no output. `lines.join('\n')` left the last
 * line unterminated, so the next command's output ran into it.
 */
export function joinLines(lines: readonly string[]): string {
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}
