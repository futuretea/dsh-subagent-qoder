import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundlePatchPaths, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import {
  DEFAULT_PROVIDER_NAME,
  PLUGIN_NAME,
  TOOL_INSERT_ID,
  TOOL_PACKAGE,
  insertRows,
  registersPackage,
} from '../tests/plugin-contract.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const failures = []

function check(name, fn) {
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      throw new Error('check() does not accept a promise')
    }
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const build = spawnSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
if (build.status !== 0) {
  process.stderr.write('package check: build failed\n')
  process.exit(build.status ?? 1)
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-package-check-'))
try {
  const pack = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], {
    cwd: root,
    encoding: 'utf8',
  })
  if (pack.status !== 0) {
    process.stderr.write(pack.stderr ?? '')
    process.stderr.write('package check: npm pack failed\n')
    process.exit(pack.status ?? 1)
  }
  let packed
  try {
    packed = JSON.parse(pack.stdout)
  } catch {
    process.stderr.write('package check: npm pack stdout was not JSON\n')
    process.exit(1)
  }
  const record = Array.isArray(packed) ? packed[0] : undefined
  if (!record || packed.length !== 1 || typeof record.filename !== 'string' || !Array.isArray(record.files)) {
    process.stderr.write('package check: npm pack JSON was not one record\n')
    process.exit(1)
  }
  const memberPaths = record.files.map((file) => file.path)
  const tarball = join(scratch, record.filename)
  const consumer = join(scratch, 'consumer')
  const nodeModules = join(consumer, 'node_modules')
  mkdirSync(nodeModules, { recursive: true })
  const extracted = spawnSync('tar', ['-xzf', tarball, '-C', nodeModules], { encoding: 'utf8' })
  if (extracted.status !== 0) {
    process.stderr.write(extracted.stderr ?? '')
    process.exit(extracted.status ?? 1)
  }
  const packageDir = join(nodeModules, 'package')
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    throw new Error('packed package.json has no name')
  }
  const installed = join(nodeModules, manifest.name)
  mkdirSync(dirname(installed), { recursive: true })
  renameSync(packageDir, installed)
  symlinkSync(join(root, 'node_modules', '@deepseek-ai'), join(nodeModules, '@deepseek-ai'))
  writeShim(join(nodeModules, '@qoder-ai', 'qoder-agent-sdk'))
  writeFileSync(join(consumer, 'package.json'), '{ "private": true, "type": "module" }\n')
  writeFileSync(join(consumer, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2024',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      verbatimModuleSyntax: true,
    },
    files: ['typecheck.ts'],
  }, null, 2)}\n`)
  writeFileSync(join(consumer, 'typecheck.ts'), [
    `import type { Config } from ${JSON.stringify(manifest.name)}`,
    '',
    'const legal: Config = {',
    "  providerName: 'qoder',",
    "  auth: 'pat-env',",
    "  permissionMode: 'dontAsk',",
    '}',
    '',
    '// @ts-expect-error',
    "const illegal: Config = { auth: 'nope' }",
    '',
    'export { illegal, legal }',
    '',
  ].join('\n'))

  const contractUrl = new URL('../tests/plugin-contract.ts', import.meta.url).href
  const runner = `
import { observeRegistration } from ${JSON.stringify(contractUrl)}
import * as plugin from ${JSON.stringify(manifest.name)}
function pack(observed) {
  return { names: observed.names, errorName: observed.error?.name }
}
const resolved = import.meta.resolve(${JSON.stringify(manifest.name)})
console.log(JSON.stringify({
  resolved,
  keys: Object.keys(plugin),
  name: plugin.name,
  inject: plugin.inject,
  config: plugin.Config != null,
  apply: typeof plugin.apply,
  omitted: pack(await observeRegistration(plugin)),
  explicit: pack(await observeRegistration(plugin, { config: { providerName: 'named-qoder' } })),
  emptyName: pack(await observeRegistration(plugin, { config: { providerName: '' } })),
  calls: globalThis.__qoderCalls ?? null,
}))
`
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', runner], {
    cwd: consumer,
    encoding: 'utf8',
  })
  let observed = null
  if (run.status !== 0) {
    failures.push(`package import: ${(run.stderr || run.stdout || 'import failed').trim()}`)
  } else {
    try {
      observed = JSON.parse(run.stdout)
    } catch {
      failures.push('package import: stdout was not one JSON object')
    }
  }

  check('packed public entry', () => {
    assert(observed, 'package import did not run')
    const resolvedPath = realpathSync(fileURLToPath(observed.resolved))
    const installedPath = realpathSync(installed)
    assert(resolvedPath.startsWith(installedPath + sep), `resolved ${resolvedPath} outside the extracted package`)
    assert(resolvedPath.endsWith(`${sep}lib${sep}index.js`), `resolved ${resolvedPath}`)
  })
  check('packed name export', () => {
    assert(observed, 'package import did not run')
    assert(observed.keys.includes('name'), 'packed module does not export name')
    assert(observed.name === PLUGIN_NAME, `packed name was ${JSON.stringify(observed.name)}`)
  })
  check('packed inject export', () => {
    assert(observed, 'package import did not run')
    assert(Array.isArray(observed.inject) && observed.inject.includes('subagents'), `packed inject was ${JSON.stringify(observed.inject)}`)
  })
  check('packed Config export', () => {
    assert(observed, 'package import did not run')
    assert(observed.config === true, 'packed module does not export Config')
  })
  check('packed apply export', () => {
    assert(observed, 'package import did not run')
    assert(observed.apply === 'function', 'packed module does not export apply')
  })
  check('packed default registration', () => {
    assert(observed, 'package import did not run')
    assert(observed.omitted.errorName === undefined, observed.omitted.errorName ?? 'default mount failed')
    assert(JSON.stringify(observed.omitted.names) === JSON.stringify([DEFAULT_PROVIDER_NAME]), `default names were ${JSON.stringify(observed.omitted.names)}`)
  })
  check('packed explicit registration', () => {
    assert(observed, 'package import did not run')
    assert(observed.explicit.errorName === undefined, observed.explicit.errorName ?? 'explicit mount failed')
    assert(JSON.stringify(observed.explicit.names) === JSON.stringify(['named-qoder']), `explicit names were ${JSON.stringify(observed.explicit.names)}`)
  })
  check('packed empty provider name', () => {
    assert(observed, 'package import did not run')
    assert(observed.emptyName.errorName === 'ValidationError', `empty name result was ${JSON.stringify(observed.emptyName)}`)
    assert(JSON.stringify(observed.emptyName.names) === '[]', `empty name registered ${JSON.stringify(observed.emptyName.names)}`)
  })
  check('packed mount does not call the runner', () => {
    assert(observed, 'package import did not run')
    assert(Array.isArray(observed.calls), 'packed module did not load the SDK boundary shim')
    assert(observed.calls.length === 0, `runner calls were ${JSON.stringify(observed.calls)}`)
  })
  check('consumer Config type', () => {
    const tsc = spawnSync(process.execPath, [
      join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--pretty',
      'false',
      '--project',
      join(consumer, 'tsconfig.json'),
    ], { encoding: 'utf8' })
    assert(tsc.status === 0, (tsc.stdout || tsc.stderr || 'tsc failed').trim())
  })
  check('packed patch registers this plugin and the tool insert', () => {
    const bundle = manifest.dsh?.bundle
    assert(bundle, 'packed package.json has no dsh.bundle')
    const files = bundlePatchPaths(installed, bundle)
    assert(files.length > 0, 'dsh.bundle.patch declared no files')
    for (const file of files) {
      assert(existsSync(file), `packed patch is missing: ${relative(installed, file)}`)
      const member = relative(installed, file).split(sep).join('/')
      assert(memberPaths.includes(member), `tarball file list omits ${member}`)
    }
    const parsed = files.flatMap((file) => loadOverlayPatches('dsh', file))
    assert(
      registersPackage(parsed, PLUGIN_NAME, manifest.name),
      `no insert row with id ${JSON.stringify(PLUGIN_NAME)} and name ${JSON.stringify(manifest.name)}`,
    )
    assert(
      registersPackage(parsed, TOOL_INSERT_ID, TOOL_PACKAGE),
      `no insert row with id ${JSON.stringify(TOOL_INSERT_ID)} and name ${JSON.stringify(TOOL_PACKAGE)}`,
    )
    const tool = insertRows(parsed).find((row) => row.id === TOOL_INSERT_ID)
    assert(tool?.config?.provider === 'qoder', `tool provider was ${JSON.stringify(tool?.config?.provider)}`)
    assert(tool?.config?.toolName === 'subagent_qoder', `tool name was ${JSON.stringify(tool?.config?.toolName)}`)
    assert(tool?.config?.maxDepth === 'provider-managed', `tool depth was ${JSON.stringify(tool?.config?.maxDepth)}`)
  })
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`package check failed: ${failure}\n`)
  process.exit(1)
}
process.stdout.write('package check passed\n')

function writeShim(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: '@qoder-ai/qoder-agent-sdk',
    type: 'module',
    exports: { '.': { types: './index.d.ts', default: './index.js' } },
  })}\n`)
  writeFileSync(join(dir, 'index.js'), [
    'globalThis.__qoderCalls = []',
    'function note(name) {',
    '  globalThis.__qoderCalls.push(name)',
    "  throw new Error('runner ' + name)",
    '}',
    "export function startDaemon() { return note('startDaemon') }",
    "export function query() { return note('query') }",
    "export function accessTokenFromEnv() { return note('accessTokenFromEnv') }",
    "export function qodercliAuth() { return note('qodercliAuth') }",
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'index.d.ts'), 'export {}\n')
}
