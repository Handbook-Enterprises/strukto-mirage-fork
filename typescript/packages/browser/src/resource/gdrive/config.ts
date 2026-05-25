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

import { normalizeFields, redactConfigWithSchema, secretStr, z } from '@viewengine/mirage-core'

/** Scope this mount to a specific Drive root. See DriveRootScope in
 *  @viewengine/mirage-core for the full type — re-imported here so
 *  GDriveConfig consumers don't need a second import. */
export interface GDriveRootScopeConfig {
  type: 'my_drive' | 'shared_drive' | 'folder'
  id?: string
}

export interface GDriveConfig {
  clientId: string
  clientSecret?: string
  refreshToken: string
  refreshFn?: (refreshToken: string) => Promise<{ accessToken: string; expiresIn: number }>
  /** Optional. Defaults to { type: 'my_drive' }. */
  rootScope?: GDriveRootScopeConfig
}

export interface GDriveConfigRedacted {
  clientId: string
  clientSecret?: '<REDACTED>'
  refreshToken: '<REDACTED>'
}

export const GDriveConfigSchema = z.object({
  clientId: z.string(),
  clientSecret: secretStr().optional(),
  refreshToken: secretStr(),
})

export function redactGDriveConfig(config: GDriveConfig): GDriveConfigRedacted {
  return redactConfigWithSchema(GDriveConfigSchema, config) as unknown as GDriveConfigRedacted
}

export function normalizeGDriveConfig(input: Record<string, unknown>): GDriveConfig {
  return normalizeFields(input, {
    rename: {
      client_id: 'clientId',
      client_secret: 'clientSecret',
      refresh_token: 'refreshToken',
    },
  }) as unknown as GDriveConfig
}
