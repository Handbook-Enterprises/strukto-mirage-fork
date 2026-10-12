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

// unzip inflates every member into the isolate's memory (~128 MB on a
// Cloudflare Durable Object, shared with co-tenant workspaces), so a large
// archive can exhaust it, reset the isolate and wipe the mount. The unzip
// commands apply two guards, both pointing at the /transfer route:
//   1. a fast pre-check that sums the local-header uncompressed sizes and
//      refuses obvious cases before anything is inflated, and
//   2. a cap on the cumulative inflated bytes inside readZipEntries, which
//      catches archives whose local headers understate the real size
//      (data-descriptor zips report 0, so the pre-check alone can undercount).

export const UNZIP_MAX_UNCOMPRESSED_BYTES = 16 * 1024 * 1024

export function unzipTooBig(label?: string): Error {
  const where = typeof label === 'string' && label !== '' ? `${label} ` : 'archive '
  return new Error(
    `unzip: ${where}exceeds the ${String(UNZIP_MAX_UNCOMPRESSED_BYTES / 1048576)} MB in-Brain extract limit (it inflates into isolate memory and would reset the mount, wiping its files). Stage it in /transfer (R2, no size limit) and extract off-platform: cp <archive> /transfer/archive.zip, then transfer-link /transfer/archive.zip and unzip the download locally.`,
  )
}
