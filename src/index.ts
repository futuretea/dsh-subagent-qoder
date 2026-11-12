/**
 * Profile-named Qoder one-shot subagent provider. Every accepted run starts a
 * private official SDK daemon with one daemon-bound query in the delegating
 * Session's workspace; the SDK owns the qodercli process and the provider
 * stops the daemon to quiescence on teardown.
 *
 * @module dsh-subagent-qoder
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  assertUsableCwd,
  NO_START_CAPABILITIES,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  qoderAuthOptions,
  startQoderRun,
  DEFAULT_QODER_PERMISSION_MODE,
  QODER_PERMISSION_MODES,
  type QoderAuthMode,
  type QoderPermissionMode,
  type QoderRunSpec,
} from './run.ts'

export const name = 'subagent-qoder'
export const inject = ['subagents']

const DEFAULT_PROVIDER_NAME = 'qoder'

/** Deployment-owned model, permission, authentication, and environment settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `qoder`). */
  providerName?: string
  /** Native Qoder model fixed for this instance; omitted to inherit Qoder settings. */
  model?: string
  /**
   * Authentication source for the per-run SDK daemon: `pat-env` reads a
   * personal access token from an environment variable (default), `qodercli`
   * reuses the local `qodercli login` state read-only.
   */
  auth?: QoderAuthMode
  /** PAT environment variable name for `auth: pat-env` (SDK default `QODER_PERSONAL_ACCESS_TOKEN`). */
  authEnvVar?: string
  /**
   * Explicit environment entries layered over the credential-scrubbed parent
   * environment for the daemon-owned qodercli child process.
   */
  env?: Record<string, string>
  /**
   * Native non-interactive permission mode fixed for this Provider instance.
   * Defaults to `dontAsk`; `bypassPermissions` and `yolo` skip permission
   * checks and are only appropriate inside an external isolation boundary.
   */
  permissionMode?: QoderPermissionMode
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  model: z.string().min(1),
  auth: z.union(['pat-env', 'qodercli']).default('pat-env'),
  authEnvVar: z.string().min(1),
  env: z.dict(z.string()).default({}),
  permissionMode: z.union([...QODER_PERMISSION_MODES])
    .default(DEFAULT_QODER_PERMISSION_MODE),
})

type ResolvedConfig = Omit<Required<Config>, 'model' | 'authEnvVar'>
  & Pick<Config, 'model' | 'authEnvVar'>

class QoderProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  async start(request: ResolvedSubagentStartRequest) {
    let cwd: string
    try {
      cwd = assertUsableCwd('subagent-qoder', 'child cwd', request.cwd)
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error('subagent-qoder: request was aborted before daemon startup')
      }
      this.ctx.logger.warn(
        `subagent-qoder "${this.name}": child start failed: %o`,
        error,
      )
      throw error
    }
    const spec: QoderRunSpec = {
      cwd,
      ...this.config.model === undefined ? {} : { model: this.config.model },
      auth: qoderAuthOptions(this.config.auth, this.config.authEnvVar),
      permissionMode: this.config.permissionMode,
      env: this.config.env,
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-qoder "${this.name}": child run failed (${stopReason}): %o`,
          error,
        )
      },
    }
    return startQoderRun(request, spec)
  }
}

/**
 * Register one Profile-named Qoder provider.
 * @param ctx - context carrying the shared subagent service.
 * @param config - registry name, optional model, authentication source, permission mode, and child environment.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    ...config.model === undefined ? {} : { model: config.model },
    auth: config.auth ?? 'pat-env',
    ...config.authEnvVar === undefined ? {} : { authEnvVar: config.authEnvVar },
    env: config.env as Record<string, string>,
    permissionMode: config.permissionMode ?? DEFAULT_QODER_PERMISSION_MODE,
  }
  ctx.subagents.registerProvider(new QoderProvider(
    resolved.providerName,
    ctx,
    resolved,
  ))
}
