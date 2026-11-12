/**
 * One-shot Qoder lifecycle: start a private SDK daemon per run, submit one
 * text task through a daemon-bound query, map only strict SDK success to
 * completion, and stop the daemon to quiescence. The SDK owns the qodercli
 * process; dsh observes it through daemon failure notifications and `stop()`.
 *
 * @module dsh-subagent-qoder/run
 */

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import {
  accessTokenFromEnv,
  qodercliAuth,
  query as officialQuery,
  startDaemon,
  type AuthOptions,
  type Daemon,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
} from '@qoder-ai/qoder-agent-sdk'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/** Qoder permission modes that cannot wait for a human response. */
export const QODER_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'dontAsk',
  'auto',
  'bypassPermissions',
  'yolo',
] as const satisfies readonly NonNullable<Options['permissionMode']>[]

/** Profile-selectable non-interactive Qoder permission mode. */
export type QoderPermissionMode = typeof QODER_PERMISSION_MODES[number]

/** Safe default for unattended Qoder runs. */
export const DEFAULT_QODER_PERMISSION_MODE: QoderPermissionMode = 'dontAsk'

/**
 * Daemon-bound queries support only `default`, `acceptEdits`, `auto`, and
 * `bypassPermissions`. The unattended `dontAsk` posture maps onto `default`
 * with this provider's approval-deny callback, which preserves the behavior:
 * nothing interactive is ever granted.
 * @param mode - configured permission mode.
 * @returns the native mode submitted to the daemon-bound query.
 */
export function nativePermissionMode(mode: QoderPermissionMode): Exclude<QoderPermissionMode, 'dontAsk'> {
  return mode === 'dontAsk' ? 'default' : mode
}

/** Qoder authentication sources supported by this provider. */
export type QoderAuthMode = 'pat-env' | 'qodercli'

/**
 * Resolve the SDK auth option for one configured source.
 * @param mode - configured authentication source.
 * @param envVar - optional PAT environment variable name for `pat-env`.
 * @returns the official SDK auth option.
 */
export function qoderAuthOptions(mode: QoderAuthMode, envVar?: string): AuthOptions {
  return mode === 'qodercli' ? qodercliAuth() : accessTokenFromEnv(envVar)
}

type QoderFailureStage =
  | 'daemon-start'
  | 'query-start'
  | 'query-run'
  | 'process'
  | 'teardown'

type QoderFailureCategory =
  | 'auth'
  | 'limit'
  | 'product-error'
  | 'invalid-result'
  | 'process'
  | 'unknown'

interface QoderFailureFacts {
  readonly stage: QoderFailureStage
  readonly category: QoderFailureCategory
}

function failureDiagnostic(facts: QoderFailureFacts): string {
  return `Product subagent failure (product: Qoder; stage: ${facts.stage}; category: ${facts.category})`
}

class QoderFailure extends Error {
  constructor(
    readonly facts: QoderFailureFacts,
    cause?: unknown,
  ) {
    super(
      `subagent-qoder: ${failureDiagnostic(facts)}`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'QoderFailure'
  }
}

/**
 * Hide an unpublished startup failure behind fixed safe facts.
 * @param stage - startup phase that failed.
 * @param cause - original host-side failure retained only on the Error cause chain.
 * @returns a rejection safe to expose through the subagent start boundary.
 */
export function qoderStartupFailure(stage: 'daemon-start' | 'query-start', cause: unknown): Error {
  const category = cause instanceof Error && cause.name === 'AuthAccessTokenEnvVarError'
    ? 'auth'
    : 'unknown'
  return new QoderFailure({ stage, category }, cause)
}

function resultFailureCategory(subtype: SDKResultMessage['subtype']): QoderFailureCategory {
  switch (subtype) {
    case 'error_max_turns':
    case 'error_max_budget_usd':
      return 'limit'
    case 'error_during_execution':
      return 'product-error'
    default:
      return 'unknown'
  }
}

function unattendedDiagnostic(
  mode: QoderPermissionMode,
  request: 'tool permission' | 'MCP elicitation' | 'permission denial',
  decision: 'denied' | 'declined',
  reason: string,
): string {
  return `Qoder unattended decision (mode: ${mode}; request: ${request}; decision: ${decision}): ${reason}`
}

/** Fully resolved inputs for one Qoder daemon run. */
export interface QoderRunSpec {
  /** Selected child working directory supplied to the daemon-bound query. */
  readonly cwd: string
  /** Profile-selected native model; omitted to preserve Qoder settings. */
  readonly model?: string
  /** Resolved official SDK auth option. */
  readonly auth: AuthOptions
  /** Profile-selected native non-interactive permission mode. */
  readonly permissionMode: QoderPermissionMode
  /** Explicit deployment/test environment layered after shared scrubbing. */
  readonly env: Record<string, string>
  /** Host diagnostic sink for a product failure kept outside model-visible text. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed SDK failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Validate and preserve the one-shot task before crossing the SDK boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact text sequence joined into one SDK prompt.
 */
export function textTask(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) {
    throw new Error('subagent-qoder: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-qoder: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-qoder: the one-shot task must not be empty')
  }
  return texts.join('')
}

/**
 * Strictly derive the only SDK result that can complete a shared run.
 * @param message - an official discriminated result union.
 * @returns exact final text for a successful, non-error result.
 */
export function successfulResult(message: SDKResultMessage): string {
  if (message.subtype !== 'success') {
    const category = resultFailureCategory(message.subtype)
    const detail = category === 'unknown'
      ? undefined
      : message.errors.join('; ')
    throw new QoderFailure(
      { stage: 'query-run', category },
      detail === undefined || detail.length === 0
        ? undefined
        : new Error(detail),
    )
  }
  if (message.is_error || message.result.trim().length === 0) {
    throw new QoderFailure({
      stage: 'query-run',
      category: 'invalid-result',
    })
  }
  return message.result
}

/**
 * Consume the complete SDK stream and require one strict success plus normal
 * iterator completion.
 * @param query - published official SDK query.
 * @param onPermissionDenied - records a safe fact when the SDK reports native denial.
 * @param onResult - records that the SDK supplied a terminal result message.
 * @returns the completed shared result.
 */
export async function consumeQoderQuery(
  query: AsyncIterable<SDKMessage>,
  onPermissionDenied?: () => void,
  onResult?: () => void,
): Promise<SubagentResult> {
  let answer: string | undefined
  for await (const message of query) {
    if (message.type === 'system' && message.subtype === 'permission_denied') {
      onPermissionDenied?.()
      continue
    }
    if (message.type !== 'result') continue
    onResult?.()
    answer = successfulResult(message)
  }
  if (answer === undefined) {
    throw new QoderFailure({
      stage: 'query-run',
      category: 'invalid-result',
    })
  }
  return {
    output: [{ type: 'text', text: answer }],
    stopReason: 'completed',
  }
}

/**
 * Build the fixed official SDK options for one daemon-bound one-shot run.
 * Daemon-bound queries must not repeat daemon-owned launch settings.
 * @param spec - Workspace, environment, and diagnostic policy.
 * @param controller - per-run cancellation owner.
 * @param captureDiagnostic - receives safe facts from unattended interaction callbacks.
 * @returns options that inherit native settings while disabling persistence and user questions.
 */
export function qoderQueryOptions(
  spec: QoderRunSpec,
  controller: AbortController,
  captureDiagnostic: (diagnostic: string) => void,
): Options {
  return {
    abortController: controller,
    cwd: spec.cwd,
    ...spec.model === undefined ? {} : { model: spec.model },
    persistSession: false,
    permissionMode: nativePermissionMode(spec.permissionMode),
    ...spec.permissionMode === 'bypassPermissions' || spec.permissionMode === 'yolo'
      ? { allowDangerouslySkipPermissions: true }
      : {
        canUseTool: (_toolName, _input, options) => {
          captureDiagnostic(unattendedDiagnostic(
            spec.permissionMode,
            'tool permission',
            'denied',
            'the provider does not request human approval',
          ))
          return Promise.resolve({
            behavior: 'deny' as const,
            message: 'This unattended Qoder subagent cannot request human approval.',
            toolUseID: options.toolUseID,
          })
        },
      },
    onElicitation: () => {
      captureDiagnostic(unattendedDiagnostic(
        spec.permissionMode,
        'MCP elicitation',
        'declined',
        'the provider does not collect interactive MCP input',
      ))
      return Promise.resolve({ action: 'decline' })
    },
  }
}

/**
 * Stop the daemon-bound query and its private daemon, and prove quiescence.
 * @param query - official SDK query, when creation reached that point.
 * @param daemon - the run-private daemon that owns the qodercli process.
 */
export async function disposeQoderDaemon(
  query: Pick<Query, 'close'> | undefined,
  daemon: Daemon,
): Promise<void> {
  const failures: Error[] = []
  try {
    await query?.close()
  } catch (error: unknown) {
    failures.push(thrown(error))
  }
  try {
    await daemon.stop()
  } catch (error: unknown) {
    failures.push(thrown(error))
  }
  const firstFailure = failures[0]
  if (firstFailure !== undefined) {
    throw new QoderFailure(
      { stage: 'teardown', category: 'unknown' },
      failures.length === 1
        ? firstFailure
        : new AggregateError(failures, 'Qoder teardown failures'),
    )
  }
}

/**
 * Start the run-private daemon and its daemon-bound query, rolling back the
 * daemon when either step fails.
 * @param spec - Workspace, environment, and diagnostic policy.
 * @param prompt - validated one-shot task text.
 * @param controller - per-run cancellation owner wired to the query.
 * @param captureDiagnostic - receives safe facts from unattended callbacks.
 * @returns the started daemon and published query.
 * @throws a fixed-facts startup failure after cleanup, never a partial child.
 */
async function startQoderChild(
  spec: QoderRunSpec,
  prompt: string,
  controller: AbortController,
  captureDiagnostic: (diagnostic: string) => void,
): Promise<{ daemon: Daemon, query: Query }> {
  let daemon: Daemon | undefined
  try {
    daemon = await startDaemon({
      auth: spec.auth,
      // Pin the SDK-bundled worker runtime: the default `process` launch mode
      // resolves a system `qodercli`, whose version may not speak this SDK's
      // daemon protocol.
      launchMode: 'worker',
      env: { ...scrubbedParentEnv(), ...spec.env },
      stderr: (data) => {
        try {
          // Synchronous fd forwarding preserves byte order without owning a
          // backpressure queue. A slow host sink can block this event-loop turn.
          writeFileSync(process.stderr.fd, data)
        } catch {
          // Host stderr is an observation sink, not a run failure authority.
        }
      },
    })
    const query = officialQuery({
      prompt,
      options: {
        ...qoderQueryOptions(spec, controller, captureDiagnostic),
        daemon,
      },
    })
    if (controller.signal.aborted) {
      throw new Error('subagent-qoder: request was aborted before run publication')
    }
    return { daemon, query }
  } catch (error: unknown) {
    const startupFailure = qoderStartupFailure(
      daemon === undefined ? 'daemon-start' : 'query-start',
      error,
    )
    if (daemon !== undefined) {
      try {
        await daemon.stop()
      } catch (stopError: unknown) {
        throw new AggregateError(
          [startupFailure, thrown(stopError)],
          `${startupFailure.message}; ${thrown(stopError).message}`,
        )
      }
    }
    throw startupFailure
  }
}

/**
 * Watch the run-private daemon for process-level failure.
 * @param daemon - daemon that owns the run's qodercli process.
 * @returns the delayed failure race plus its listener detach.
 */
function watchDaemonFailure(daemon: Daemon): {
  readonly failure: Promise<never>
  readonly detach: () => void
} {
  const daemonFailure = Promise.withResolvers<never>()
  const detach = daemon.onFailure(
    error => { daemonFailure.reject(thrown(error)) },
  )
  const failure = daemonFailure.promise.catch(
    async (error: Error): Promise<never> => {
      // Frames already queued by the dying CLI remain authoritative. One I/O
      // turn lets them settle before the daemon failure ends the run.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      throw error
    },
  )
  void failure.catch(() => {})
  return { failure, detach }
}

/** Mutable one-diagnostic sink shared by the unattended callbacks and failure classification. */
interface DiagnosticChannel {
  readonly capture: (value: string) => void
  readonly prepend: (facts: QoderFailureFacts) => void
  readonly read: () => string | undefined
}

function createDiagnosticChannel(): DiagnosticChannel {
  let diagnostic: string | undefined
  return {
    capture: (value) => {
      diagnostic = value
    },
    prepend: (facts) => {
      const failure = failureDiagnostic(facts)
      diagnostic = diagnostic === undefined ? failure : `${failure}\n${diagnostic}`
    },
    read: () => diagnostic,
  }
}

/**
 * Race the one-shot query against daemon failure and reclassify rejections
 * with the run's fixed failure facts before they settle.
 * @param query - published official SDK query.
 * @param daemonWatch - failure race plus detach for the run-private daemon.
 * @param spec - Workspace, environment, and diagnostic policy.
 * @param diagnostics - run diagnostic sink.
 * @returns the completed shared result.
 */
function attemptQoderResult(
  query: Query,
  daemonWatch: ReturnType<typeof watchDaemonFailure>,
  spec: QoderRunSpec,
  diagnostics: DiagnosticChannel,
): Promise<SubagentResult> {
  let receivedResult = false
  return Promise.race([
    consumeQoderQuery(query, () => {
      diagnostics.capture(unattendedDiagnostic(
        spec.permissionMode,
        'permission denial',
        'denied',
        'Qoder denied the request before an interactive prompt',
      ))
    }, () => {
      receivedResult = true
    }),
    daemonWatch.failure,
  ]).catch((error: unknown) => {
    const facts: QoderFailureFacts = error instanceof QoderFailure
      ? error.facts
      : receivedResult
        ? { stage: 'query-run', category: 'unknown' }
        : { stage: 'process', category: 'process' }
    diagnostics.prepend(facts)
    throw error instanceof QoderFailure
      ? error
      : new QoderFailure(facts, thrown(error))
  })
}

/**
 * Start the run-private daemon and its one daemon-bound query, and publish
 * the one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - Workspace, environment, and diagnostic policy.
 * @returns the published run after both daemon and query exist.
 */
export async function startQoderRun(
  request: SubagentStartRequest,
  spec: QoderRunSpec,
): Promise<SubagentRun> {
  const prompt = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-qoder: request was aborted before daemon startup')
  }

  const controller = new AbortController()
  const requestCancel = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('subagent-qoder: run cancelled locally'))
    }
  }
  request.signal.addEventListener('abort', requestCancel, { once: true })
  const reportFailure = (error: Error): void => {
    try {
      spec.onError?.(error, 'error')
    } catch {
      // Host diagnostic logging cannot replace the product failure.
    }
  }
  const diagnostics = createDiagnosticChannel()

  let child: { daemon: Daemon, query: Query }
  try {
    child = await startQoderChild(spec, prompt, controller, diagnostics.capture)
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', requestCancel)
    requestCancel()
    reportFailure(thrown(error))
    throw error
  }

  const daemonWatch = watchDaemonFailure(child.daemon)
  const result = settleRunResult({
    attempt: () => attemptQoderResult(child.query, daemonWatch, spec, diagnostics),
    collectOutput: () => [],
    collectDiagnostic: diagnostics.read,
    cancelled: () => controller.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort: requestCancel,
  })

  return subprocessRunHandle({
    id: brandString<SessionId>(randomUUID()),
    result,
    signal: request.signal,
    onAbort: requestCancel,
    requestCancel,
    teardown: async () => {
      try {
        try {
          await disposeQoderDaemon(child.query, child.daemon)
        } finally {
          daemonWatch.detach()
        }
      } catch (error: unknown) {
        const failure = thrown(error)
        reportFailure(failure)
        throw failure
      }
    },
  })
}
