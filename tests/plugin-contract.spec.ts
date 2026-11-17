import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import {
  DEFAULT_PROVIDER_NAME,
  PLUGIN_NAME,
  TOOL_INSERT_ID,
  TOOL_PACKAGE,
  insertRows,
  jsExpression,
  loadPatch,
  observeRegistration,
  registersPackage,
} from './plugin-contract.ts'

const calls = vi.hoisted(() => {
  const seen: string[] = []
  return seen
})

vi.mock('@qoder-ai/qoder-agent-sdk', () => ({
  startDaemon: () => {
    calls.push('startDaemon')
    throw new Error('runner startDaemon')
  },
  query: () => {
    calls.push('query')
    throw new Error('runner query')
  },
  accessTokenFromEnv: () => {
    calls.push('accessTokenFromEnv')
    throw new Error('runner accessTokenFromEnv')
  },
  qodercliAuth: () => {
    calls.push('qodercliAuth')
    throw new Error('runner qodercliAuth')
  },
}))

function readManifest(value: unknown): { readonly name: string, readonly files: readonly string[] } {
  if (typeof value !== 'object' || value === null) throw new Error('package.json is not an object')
  if (!('name' in value) || typeof value.name !== 'string') throw new Error('package.json has no name')
  if (!('files' in value) || !Array.isArray(value.files) || !value.files.every((entry) => typeof entry === 'string')) {
    throw new Error('package.json has no files list')
  }
  return { name: value.name, files: value.files }
}

const manifest = readManifest(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')))
const pkgName = manifest.name

function row(name = `'${pkgName}'`, extra = ''): string {
  return `- insert:\n    - id: ${PLUGIN_NAME}\n      name: ${name}${extra}\n`
}

beforeEach(() => {
  calls.length = 0
})

async function expectRegistered(
  input: { readonly config: unknown } | undefined,
  names: readonly string[],
): Promise<void> {
  const observed = input === undefined
    ? await observeRegistration(plugin)
    : await observeRegistration(plugin, input)
  expect(observed.error).toBeUndefined()
  expect(observed.names).toEqual(names)
  expect(calls).toEqual([])
}

async function expectRejected(config: unknown): Promise<void> {
  const observed = await observeRegistration(plugin, { config })
  expect(observed.error).toBeInstanceOf(Error)
  expect(observed.error?.name).toBe('ValidationError')
  expect(observed.names).toEqual([])
  expect(calls).toEqual([])
}

describe('subagent-qoder registration', () => {
  it('exports the plugin name and the subagents inject', () => {
    expect(plugin.name).toBe(PLUGIN_NAME)
    expect(plugin.inject).toContain('subagents')
  })

  it('registers the default provider when config is omitted', async () => {
    await expectRegistered(undefined, [DEFAULT_PROVIDER_NAME])
  })

  it('registers an explicit provider name', async () => {
    await expectRegistered({ config: { providerName: 'named-qoder' } }, ['named-qoder'])
  })

  it('uses the default provider when providerName is null', async () => {
    await expectRegistered({ config: { providerName: null } }, [DEFAULT_PROVIDER_NAME])
  })

  it('keeps a space as a non-empty provider name', async () => {
    await expectRegistered({ config: { providerName: ' ' } }, [' '])
  })

  it('registers with another legal auth source and permission mode', async () => {
    await expectRegistered({
      config: { auth: 'qodercli', permissionMode: 'acceptEdits' },
    }, [DEFAULT_PROVIDER_NAME])
  })

  it('does not register an empty provider name', async () => {
    await expectRejected({ providerName: '' })
  })

  it('does not register an unknown auth source', async () => {
    await expectRejected({ auth: 'nope' })
  })

  it('does not register an unknown permission mode', async () => {
    await expectRejected({ permissionMode: 'interactive' })
  })
})

describe('cordis.patch.yml', () => {
  it('lists the bundle patch in the published files', () => {
    expect(manifest.files).toContain('cordis.patch.yml')
  })

  it('registers this package and keeps the tool insert', () => {
    const parsed = loadPatch(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
    expect(registersPackage(parsed, PLUGIN_NAME, pkgName)).toBe(true)
    expect(registersPackage(parsed, TOOL_INSERT_ID, TOOL_PACKAGE)).toBe(true)
    const rows = insertRows(parsed)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.config).toEqual({ providerName: 'qoder' })
    expect(rows[1]?.config).toEqual({
      provider: 'qoder',
      toolName: 'subagent_qoder',
      maxDepth: 'provider-managed',
    })
  })

  it('accepts a single-quoted package name', () => {
    expect(registersPackage(loadPatch(row()), PLUGIN_NAME, pkgName)).toBe(true)
  })

  it('accepts a double-quoted package name', () => {
    expect(registersPackage(loadPatch(row(`"${pkgName}"`)), PLUGIN_NAME, pkgName)).toBe(true)
  })

  it('accepts an unquoted package name', () => {
    expect(registersPackage(loadPatch(row(pkgName)), PLUGIN_NAME, pkgName)).toBe(true)
  })

  it('accepts a folded package name', () => {
    const parsed = loadPatch(`- insert:\n    - id: ${PLUGIN_NAME}\n      name: >-\n        ${pkgName}\n`)
    expect(registersPackage(parsed, PLUGIN_NAME, pkgName)).toBe(true)
  })

  it('accepts a host !!js config on the registered row', () => {
    const parsed = loadPatch(row(pkgName, '\n      config:\n        providerName: !!js qoder'))
    expect(jsExpression(insertRows(parsed)[0]?.config?.providerName)).toBe('qoder')
    expect(registersPackage(parsed, PLUGIN_NAME, pkgName)).toBe(true)
  })

  it('accepts an extra insert beside this plugin', () => {
    const parsed = loadPatch(`${row().trimEnd()}\n    - id: tool-extra\n      name: other-pkg\n`)
    expect(insertRows(parsed)).toHaveLength(2)
    expect(registersPackage(parsed, PLUGIN_NAME, pkgName)).toBe(true)
  })

  it('parses an empty list without registering this plugin', () => {
    const parsed = loadPatch('[]\n')
    expect(parsed).toEqual([])
    expect(registersPackage(parsed, PLUGIN_NAME, pkgName)).toBe(false)
  })

  it('does not treat another package insert as this plugin', () => {
    const parsed = loadPatch(`- insert:\n    - id: tool-extra\n      name: '${pkgName}'\n`)
    expect(insertRows(parsed)).toHaveLength(1)
    expect(registersPackage(parsed, PLUGIN_NAME, pkgName)).toBe(false)
  })

  it('surfaces a patch that is not a list', () => {
    expect(() => loadPatch('')).toThrow(/array/)
  })
})
