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

// Per-mount path visibility filter (include / exclude globs).
//
// A mount may declare `includeGlobs` / `excludeGlobs` (see MountInit). The
// patterns match a mount-RELATIVE path (no leading slash, no mount prefix):
// e.g. for a mount at `/slack/`, the entry `/slack/dms/alex` matches as
// `dms/alex`. Semantics:
//   - excludeGlobs win: any path matching an exclude is hidden/denied.
//   - includeGlobs (when non-empty) are an allowlist: a path is only
//     visible if it matches an include OR is a strict ancestor of one (so
//     `ls` at the root still surfaces parent dirs of allowed descendants).
//   - the mount root ('') is always visible.
//
// Two enforcement points consume this:
//   1. readdir helpers call `applyMountFilter(entries, mountPrefix)` so
//      excluded children drop out of every listing (ls / find / grep -r /
//      tree all enumerate through readdir). The active filter is supplied
//      by `Mount.executeCmd` via `runWithMountFilter` (AsyncLocalStorage),
//      so the readdir helpers stay parameter-free and the hook is a no-op
//      whenever the running mount has no globs.
//   2. the command executor calls `isPathVisible` on each path argument to
//      deny direct access (`cat /slack/dms/x` -> ENOENT) to excluded paths.
//
// Glob grammar: `*` = any run of non-`/` chars, `**` = any run incl. `/`,
// `?` = one non-`/` char, everything else literal. As a convenience the
// "whole subtree" form `X/**` also matches `X` itself, so `dms/**` makes
// the `dms` directory entry vanish rather than linger as an empty dir.

import { createAsyncContext } from './async_context.ts'

interface CompiledPattern {
  // Matches a path exactly (the full mount-relative path equals the glob).
  exact: RegExp
  // Matches a path that is a strict ancestor of something the glob could
  // match — used for include allowlists so listing a parent dir works.
  prefix: RegExp
}

export interface CompiledMountFilter {
  /** Normalised mount prefix (no trailing slash), e.g. `/slack`. */
  prefix: string
  includes: CompiledPattern[]
  excludes: CompiledPattern[]
}

// Convert one glob to a regex anchored to a full mount-relative path.
function globToRegex(glob: string): RegExp {
  let out = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    // `/**` (end, or before another `/`) => optional subtree: matches the
    // directory entry itself AND everything beneath it.
    if (c === '/' && glob[i + 1] === '*' && glob[i + 2] === '*') {
      out += '(?:/.*)?'
      i += 3
      if (glob[i] === '/') i += 1
      continue
    }
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i += 2
        if (glob[i] === '/') i += 1
        continue
      }
      out += '[^/]*'
      i += 1
      continue
    }
    if (c === '?') {
      out += '[^/]'
      i += 1
      continue
    }
    if (c !== undefined && /[\\^$+.()|[\]{}]/.test(c)) {
      out += `\\${c}`
      i += 1
      continue
    }
    out += c
    i += 1
  }
  return new RegExp(`^${out}$`)
}

function compilePattern(raw: string): CompiledPattern {
  const trimmed = raw.replace(/^\/+/, '')
  const exact = globToRegex(trimmed)
  const segments = trimmed.split('/').filter((s) => s.length > 0)
  if (segments.length === 0) {
    return { exact, prefix: /^.*$/ }
  }
  // Prefix alternatives: empty, segs[0], segs[0]/segs[1], … (one short of
  // the full pattern). Lets an ancestor dir stay visible under an include.
  const alts = ['^$']
  let acc = ''
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]
    if (seg === undefined) continue
    const segRegex = globToRegex(seg).source.replace(/^\^|\$$/g, '')
    acc = acc === '' ? segRegex : `${acc}/${segRegex}`
    alts.push(`^${acc}$`)
  }
  return { exact, prefix: new RegExp(alts.join('|')) }
}

export function compileMountFilter(
  prefix: string,
  includeGlobs: readonly string[] | undefined,
  excludeGlobs: readonly string[] | undefined,
): CompiledMountFilter | null {
  const includes = (includeGlobs ?? []).filter((g) => g.length > 0).map(compilePattern)
  const excludes = (excludeGlobs ?? []).filter((g) => g.length > 0).map(compilePattern)
  if (includes.length === 0 && excludes.length === 0) return null
  return { prefix: prefix.replace(/\/+$/, ''), includes, excludes }
}

/**
 * Is `relPath` (mount-relative, no leading/trailing slash) visible under
 * the filter? Excludes win; empty includes = allow-all; the root ('') is
 * always visible; an ancestor of an include pattern stays visible.
 */
export function isVisible(relPath: string, filter: CompiledMountFilter): boolean {
  const norm = relPath.replace(/^\/+|\/+$/g, '')
  if (filter.excludes.some((p) => p.exact.test(norm))) return false
  if (filter.includes.length === 0) return true
  if (norm === '') return true
  return filter.includes.some((p) => p.exact.test(norm) || p.prefix.test(norm))
}

// Strip the mount prefix off a full path to get the mount-relative form.
function relativeOf(fullPath: string, mountPrefix: string): string {
  const prefix = mountPrefix.replace(/\/+$/, '')
  let s = fullPath
  if (prefix !== '' && s.startsWith(prefix)) s = s.slice(prefix.length)
  return s.replace(/^\/+|\/+$/g, '')
}

/**
 * Public helper for the executor's access guard: is the full `path`
 * visible under `filter`? (Same rule as listing visibility.)
 */
export function isPathVisible(fullPath: string, filter: CompiledMountFilter): boolean {
  return isVisible(relativeOf(fullPath, filter.prefix), filter)
}

// ── active-filter context ────────────────────────────────────────────────
// Set by Mount.executeCmd around a command run so readdir helpers (which
// have no handle on the Mount) can consult it. AsyncLocalStorage-backed so
// concurrent commands in different async contexts don't clobber each other.

const activeFilter = createAsyncContext<CompiledMountFilter>()

export function runWithMountFilter<R>(
  filter: CompiledMountFilter | null,
  fn: () => R | Promise<R>,
): R | Promise<R> {
  if (filter === null) return fn()
  return activeFilter.run(filter, fn)
}

/**
 * readdir-helper hook. Drops entries hidden by the active mount filter.
 * No-op when no filter is active (the common case) or when the active
 * filter belongs to a different mount than `mountPrefix` (cross-mount
 * safety). `entries` are full paths as returned by readdir helpers
 * (`<mountPrefix>/<child>`).
 */
export function applyMountFilter(entries: string[], mountPrefix: string): string[] {
  const filter = activeFilter.getStore()
  if (filter === undefined) return entries
  const norm = mountPrefix.replace(/\/+$/, '')
  if (filter.prefix !== norm) return entries
  return entries.filter((e) => isVisible(relativeOf(e, norm), filter))
}
