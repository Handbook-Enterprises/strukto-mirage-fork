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
import {
  applyMountFilter,
  compileMountFilter,
  isPathVisible,
  isVisible,
  runWithMountFilter,
} from './mount_filter.ts'

describe('compileMountFilter', () => {
  it('returns null when no globs are supplied', () => {
    expect(compileMountFilter('/slack', undefined, undefined)).toBeNull()
    expect(compileMountFilter('/slack', [], [])).toBeNull()
  })

  it('compiles when at least one glob is present', () => {
    expect(compileMountFilter('/slack', undefined, ['dms/**'])).not.toBeNull()
  })
})

describe('isVisible', () => {
  const f = (inc: string[], exc: string[]) =>
    compileMountFilter('/m', inc, exc) ?? { prefix: '/m', includes: [], excludes: [] }

  it('exclude hides exact match and subtree; X/** also hides X', () => {
    const filter = f([], ['dms/**'])
    expect(isVisible('dms', filter)).toBe(false)
    expect(isVisible('dms/alex', filter)).toBe(false)
    expect(isVisible('dms/alex/2026', filter)).toBe(false)
    expect(isVisible('channels', filter)).toBe(true)
  })

  it('empty include allowlist => everything visible (subject to exclude)', () => {
    const filter = f([], [])
    expect(isVisible('anything', filter)).toBe(true)
    expect(isVisible('', filter)).toBe(true)
  })

  it('include allowlist hides non-matches but keeps ancestors + root visible', () => {
    const filter = f(['channels/**', 'users.tsv'], [])
    expect(isVisible('', filter)).toBe(true) // root
    expect(isVisible('channels', filter)).toBe(true) // X/** matches X
    expect(isVisible('channels/general', filter)).toBe(true)
    expect(isVisible('users.tsv', filter)).toBe(true)
    expect(isVisible('dms', filter)).toBe(false)
    expect(isVisible('dms/alex', filter)).toBe(false)
  })

  it('ancestor of a deep include stays visible', () => {
    const filter = f(['channels/clients-*/**'], [])
    expect(isVisible('channels', filter)).toBe(true) // ancestor
    expect(isVisible('channels/clients-acme', filter)).toBe(true)
    expect(isVisible('channels/clients-acme/2026', filter)).toBe(true)
    expect(isVisible('channels/other', filter)).toBe(false)
  })

  it('exclude wins over include', () => {
    const filter = f(['**'], ['dms/**'])
    expect(isVisible('channels', filter)).toBe(true)
    expect(isVisible('dms', filter)).toBe(false)
  })

  it('* matches within a single segment only; ** spans segments', () => {
    // a/* (exclude) matches the single-segment child a/b => hidden
    expect(isVisible('a/b', f([], ['a/*']))).toBe(false)
    // a/* does NOT reach the deeper a/b/c => not excluded => visible
    expect(isVisible('a/b/c', f([], ['a/*']))).toBe(true)
    // a/** spans segments => a/b/c excluded
    expect(isVisible('a/b/c', f([], ['a/**']))).toBe(false)
  })

  it('? matches exactly one non-slash char', () => {
    const filter = f([], ['ab?'])
    expect(isVisible('abc', filter)).toBe(false)
    expect(isVisible('ab', filter)).toBe(true)
    expect(isVisible('abcd', filter)).toBe(true)
  })
})

describe('isPathVisible (full path -> mount-relative)', () => {
  it('relativises against the mount prefix', () => {
    const filter = compileMountFilter('/slack', [], ['dms/**'])!
    expect(isPathVisible('/slack/dms/alex', filter)).toBe(false)
    expect(isPathVisible('/slack/channels/general', filter)).toBe(true)
    expect(isPathVisible('/slack', filter)).toBe(true) // mount root
    expect(isPathVisible('/slack/', filter)).toBe(true)
  })
})

describe('applyMountFilter (readdir hook)', () => {
  it('is a no-op when no filter context is active', () => {
    const entries = ['/slack/channels', '/slack/dms']
    expect(applyMountFilter(entries, '/slack')).toEqual(entries)
  })

  it('drops excluded entries inside runWithMountFilter for the matching prefix', async () => {
    const filter = compileMountFilter('/slack', [], ['dms/**'])!
    await runWithMountFilter(filter, async () => {
      const out = applyMountFilter(['/slack/channels', '/slack/dms', '/slack/users.tsv'], '/slack')
      expect(out).toEqual(['/slack/channels', '/slack/users.tsv'])
    })
  })

  it('does not filter a different mount prefix (cross-mount safety)', async () => {
    const filter = compileMountFilter('/slack', [], ['dms/**'])!
    await runWithMountFilter(filter, async () => {
      const entries = ['/gdrive/dms', '/gdrive/x']
      expect(applyMountFilter(entries, '/gdrive')).toEqual(entries)
    })
  })

  it('restores no-filter after the context exits', async () => {
    const filter = compileMountFilter('/slack', [], ['dms/**'])!
    await runWithMountFilter(filter, async () => {})
    expect(applyMountFilter(['/slack/dms'], '/slack')).toEqual(['/slack/dms'])
  })
})
