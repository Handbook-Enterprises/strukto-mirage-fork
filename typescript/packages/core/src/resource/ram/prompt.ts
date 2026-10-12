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

export const RAM_PROMPT = `{prefix}
  In-memory filesystem. Files and directories are created on demand.
  Standard commands: ls, cat, head, tail, grep, wc, find, tree, mkdir, touch, cp, mv, rm, tee, echo > file.
  Held in the Durable Object isolate's memory (~128 MB, shared with co-tenant
  workspaces). A single oversized file, or unzipping a large archive here,
  can exceed that limit and reset the isolate, which wipes all of /ram. Stage
  and process large files in /transfer (R2, no size limit) instead.`
