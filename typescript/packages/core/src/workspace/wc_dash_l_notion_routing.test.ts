// Repro test for: `wc -l <path>` against a non-RAM mount silently routes
// to the default RAM mount and returns "wc: file not found", even though
// `wc <path>` (no flags) and `wc -L <path>`, `wc -c <path>`, etc. all
// correctly hit the per-resource wc handler.
//
// The mount-routing should pick the mount that matches the path, not the
// cwd, for path-bearing commands.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { NotionAccessor } from '../accessor/notion.ts'
import { NOTION_COMMANDS } from '../commands/builtin/notion/index.ts'
import type { NotionTransport } from '../core/notion/_client.ts'
import { OpsRegistry } from '../ops/registry.ts'
import type { Resource } from '../resource/base.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { createShellParser } from '../shell/parse.ts'
import { DEFAULT_SESSION_ID, MountMode } from '../types.ts'
import { Workspace } from './workspace.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))
const DEC = new TextDecoder()

class CannedTransport implements NotionTransport {
  constructor(private readonly canned: Record<string, () => unknown>) {}
  callTool(name: string, _args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const make = this.canned[name]
    if (make === undefined) return Promise.reject(new Error(`canned: no response for ${name}`))
    const r = make()
    return Promise.resolve(r as Record<string, unknown>)
  }
}

class TestNotionResource implements Resource {
  readonly kind = 'notion'
  readonly accessor: NotionAccessor
  constructor(transport: NotionTransport) {
    this.accessor = new NotionAccessor(transport)
  }
  async open(): Promise<void> {}
  async close(): Promise<void> {}
  commands() {
    return NOTION_COMMANDS
  }
}

async function makeWs() {
  const ram = new RAMResource()
  const transport = new CannedTransport({
    'API-post-search': () => ({
      results: [
        {
          id: 'abc123def4567890123456789012345b',
          object: 'page',
          parent: { type: 'workspace' },
          last_edited_time: '2026-05-25T00:00:00.000Z',
          properties: { title: { title: [{ plain_text: 'My Page' }] } },
        },
      ],
      has_more: false,
    }),
    'API-retrieve-block-children': () => ({ results: [], has_more: false }),
    'API-retrieve-a-page': () => ({
      id: 'abc123def4567890123456789012345b',
      last_edited_time: '2026-05-25T00:00:00.000Z',
      properties: { title: { title: [{ plain_text: 'My Page' }] } },
    }),
  })
  const notion = new TestNotionResource(transport)
  const registry = new OpsRegistry()
  registry.registerResource(ram)
  registry.registerResource(notion)
  const parser = await createShellParser({ engineWasm, grammarWasm })
  // Mirror ve-brain: default READ, overrides per mount, no `ops` param.
  const ws = new Workspace(
    { '/r': ram, '/n': notion },
    {
      mode: MountMode.READ,
      modeOverrides: { '/r': MountMode.WRITE },
      ops: registry,
      shellParser: parser,
    },
  )
  ws.getSession(DEFAULT_SESSION_ID).cwd = '/'
  return ws
}

describe('wc -l routing across resource kinds', () => {
  it('wc /n/.../page.json (no flag) reaches notion handler', async () => {
    const ws = await makeWs()
    try {
      const io = await ws.execute('wc "/n/My Page__abc123def4567890123456789012345b/page.json"')
      const out = DEC.decode(io.stdout)
      const err = DEC.decode(io.stderr)
      expect(err).not.toContain('file not found')
      expect(out).not.toBe('')
    } finally {
      await ws.close()
    }
  })

  it('wc -L /n/.../page.json reaches notion handler', async () => {
    const ws = await makeWs()
    try {
      const io = await ws.execute('wc -L "/n/My Page__abc123def4567890123456789012345b/page.json"')
      const err = DEC.decode(io.stderr)
      expect(err).not.toContain('file not found')
    } finally {
      await ws.close()
    }
  })

  it('wc -l /n/.../page.json reaches notion handler (BUG: routes to RAM today)', async () => {
    const ws = await makeWs()
    try {
      const io = await ws.execute('wc -l "/n/My Page__abc123def4567890123456789012345b/page.json"')
      const err = DEC.decode(io.stderr)
      expect(err).not.toContain('file not found')
    } finally {
      await ws.close()
    }
  })
})
