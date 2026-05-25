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

import { GoogleApiAccessor } from './google_api.ts'
import type { TokenManager } from '../core/google/_client.ts'

/** Scope the GDrive mount to a specific root in the user's Drive.
 *
 *  - my_drive (default): the user's My Drive root. Same as the legacy
 *    behavior — readdir at the mount root lists "root in parents".
 *  - shared_drive: the root of a Shared Drive (Team Drive). `id` is the
 *    driveId (which doubles as the root folder id in Drive's data model,
 *    so `'<id>' in parents` lists the drive's top-level contents).
 *  - folder: any folder, in My Drive or a Shared Drive. `id` is the
 *    folderId. Useful for handing an agent a tight per-project view.
 *
 *  Sub-folder navigation inside the mount works the same regardless of
 *  rootScope — the standard parent-id lookups via the IndexCache cover
 *  every depth past the root. supportsAllDrives + includeItemsFromAllDrives
 *  are set unconditionally on every Drive call (see core/google/drive.ts)
 *  so cross-drive paths resolve. */
export interface DriveRootScope {
  type: 'my_drive' | 'shared_drive' | 'folder'
  /** Required for shared_drive (the driveId) and folder (the folderId). */
  id?: string
}

export class GDriveAccessor extends GoogleApiAccessor {
  readonly rootScope: DriveRootScope

  constructor(opts: { tokenManager: TokenManager; rootScope?: DriveRootScope }) {
    super({ tokenManager: opts.tokenManager })
    this.rootScope = opts.rootScope ?? { type: 'my_drive' }
  }
}
