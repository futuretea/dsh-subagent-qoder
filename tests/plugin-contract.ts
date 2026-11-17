import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

export const PLUGIN_NAME = 'subagent-qoder'
export const DEFAULT_PROVIDER_NAME = 'qoder'
export const TOOL_INSERT_ID = 'tool-subagent-qoder'
export const TOOL_PACKAGE = '@deepseek-ai/dsh-tool-subagent'

type Overlay = ReturnType<typeof loadOverlayPatches>

export interface InsertRow {
  readonly id?: string
  readonly name?: string
  readonly config?: Readonly<Record<string, unknown>>
}

interface IsolatedSubagents {
  registerProvider(provider: unknown): () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function insertRows(patches: Overlay): InsertRow[] {
  const rows: InsertRow[] = []
  for (const patch of patches) {
    const entry: unknown = patch
    if (!isRecord(entry) || !Array.isArray(entry.insert)) continue
    for (const row of entry.insert) {
      if (!isRecord(row)) continue
      const id = typeof row.id === 'string' ? row.id : undefined
      const name = typeof row.name === 'string' ? row.name : undefined
      const config = isRecord(row.config) ? row.config : undefined
      rows.push(config === undefined ? { id, name } : { id, name, config })
    }
  }
  return rows
}

export function registersPackage(patches: Overlay, id: string, packageName: string): boolean {
  return insertRows(patches).some((row) => row.id === id && row.name === packageName)
}

export function jsExpression(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.__jsExpr !== 'string') return undefined
  return value.__jsExpr
}

export function loadPatch(text: string): Overlay {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-patch-'))
  const file = join(dir, 'cordis.patch.yml')
  try {
    writeFileSync(file, text)
    return loadOverlayPatches('dsh', file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export interface RegistrationObservation {
  readonly names: readonly string[]
  readonly error?: Error
}

function provideSubagents(ctx: Context, name: string, service: IsolatedSubagents): void {
  ctx.provide(name, service)
}

export async function observeRegistration(
  plugin: Parameters<Context['plugin']>[0],
  input?: { readonly config: unknown },
): Promise<RegistrationObservation> {
  const names: string[] = []
  const ctx = new Context()
  provideSubagents(ctx, 'subagents', {
    registerProvider(provider: unknown) {
      if (isRecord(provider) && typeof provider.name === 'string') names.push(provider.name)
      return () => {}
    },
  })
  try {
    const fiber = input === undefined
      ? await ctx.plugin(plugin)
      : await ctx.plugin(plugin, input.config)
    await fiber.dispose()
    return { names }
  } catch (error: unknown) {
    return {
      names,
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}
