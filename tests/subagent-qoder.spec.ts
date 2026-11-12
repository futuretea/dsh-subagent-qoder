import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage, SDKResultMessage } from '@qoder-ai/qoder-agent-sdk'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import {
  consumeQoderQuery,
  DEFAULT_QODER_PERMISSION_MODE,
  nativePermissionMode,
  qoderAuthOptions,
  qoderQueryOptions,
  qoderStartupFailure,
  startQoderRun,
  successfulResult,
  textTask,
  type QoderRunSpec,
} from '../src/run.ts'

const mocks = vi.hoisted(() => ({
  startDaemon: vi.fn(),
  query: vi.fn(),
}))

vi.mock('@qoder-ai/qoder-agent-sdk', () => ({
  startDaemon: mocks.startDaemon,
  query: mocks.query,
  accessTokenFromEnv: (envVar?: string) => ({
    type: 'accessToken',
    accessToken: { envVar: envVar ?? 'QODER_PERSONAL_ACCESS_TOKEN' },
  }),
  qodercliAuth: () => ({ type: 'qodercli' }),
}))

function textResult(overrides: Record<string, unknown> = {}): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: 'the answer',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: 'uuid',
    session_id: 'session',
    ...overrides,
  } as unknown as SDKResultMessage
}

/** Narrow daemon double: startQoderRun only touches onFailure and stop. */
function fakeDaemon() {
  const listeners: Array<(error: Error) => void> = []
  return {
    state: 'ready' as const,
    onFailure(listener: (error: Error) => void): () => void {
      listeners.push(listener)
      return () => {}
    },
    stop: vi.fn(async (): Promise<void> => {}),
    fail(error: Error): void {
      for (const listener of listeners) listener(error)
    },
  }
}

/** Narrow query double: the provider only iterates and closes it. */
function fakeQuery(messages: SDKMessage[]) {
  return {
    close: vi.fn(async (): Promise<void> => {}),
    interrupt: vi.fn(async (): Promise<undefined> => undefined),
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
      for (const message of messages) yield message
    },
  }
}

function startRequest(text: string, controller = new AbortController()): SubagentStartRequest {
  return {
    prompt: [{ type: 'text', text }],
    signal: controller.signal,
  } as SubagentStartRequest
}

/** Query double whose stream waits on an external gate before its result. */
function gatedQuery(): { query: ReturnType<typeof fakeQuery>, open: () => void } {
  let open: () => void
  const gate = new Promise<void>((resolve) => { open = resolve })
  const query = {
    close: vi.fn(async (): Promise<void> => {}),
    interrupt: vi.fn(async (): Promise<undefined> => undefined),
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
      await gate
      yield textResult()
    },
  }
  return { query, open: open! }
}

function runSpec(overrides: Partial<QoderRunSpec> = {}): QoderRunSpec {
  return {
    cwd: process.cwd(),
    auth: qoderAuthOptions('pat-env'),
    permissionMode: DEFAULT_QODER_PERMISSION_MODE,
    env: {},
    ...overrides,
  }
}

beforeEach(() => {
  mocks.startDaemon.mockReset()
  mocks.query.mockReset()
})

describe('textTask', () => {
  it('joins text blocks into one prompt', () => {
    expect(textTask([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]))
      .toBe('ab')
  })

  it('rejects empty and non-text tasks', () => {
    expect(() => textTask([])).toThrow(/only text blocks/)
    expect(() => textTask([{ type: 'image', data: 'x' } as never])).toThrow(/only text blocks/)
    expect(() => textTask([{ type: 'text', text: '  ' }])).toThrow(/must not be empty/)
  })
})

describe('successfulResult', () => {
  it('returns the result text for strict success', () => {
    expect(successfulResult(textResult())).toBe('the answer')
  })

  it('rejects flagged or empty success results', () => {
    expect(() => successfulResult(textResult({ is_error: true }))).toThrow(/invalid-result/)
    expect(() => successfulResult(textResult({ result: ' ' }))).toThrow(/invalid-result/)
  })

  it('classifies terminal error subtypes', async () => {
    const maxTurns = textResult({
      subtype: 'error_max_turns',
      errors: ['turn cap'],
      result: undefined,
    })
    await expect(async () => successfulResult(maxTurns)).rejects.toThrow(/limit/)
    const execution = textResult({
      subtype: 'error_during_execution',
      errors: ['boom'],
      result: undefined,
    })
    await expect(async () => successfulResult(execution)).rejects.toThrow(/product-error/)
  })
})

describe('consumeQoderQuery', () => {
  it('requires one strict success and completes', async () => {
    let denied = false
    let sawResult = false
    const result = await consumeQoderQuery(
      fakeQuery([
        { type: 'system', subtype: 'permission_denied' } as SDKMessage,
        textResult(),
      ]),
      () => { denied = true },
      () => { sawResult = true },
    )
    expect(result).toEqual({
      output: [{ type: 'text', text: 'the answer' }],
      stopReason: 'completed',
    })
    expect(denied).toBe(true)
    expect(sawResult).toBe(true)
  })

  it('fails without a terminal result', async () => {
    await expect(consumeQoderQuery(fakeQuery([])))
      .rejects.toThrow(/invalid-result/)
  })
})

describe('qoderQueryOptions', () => {
  it('denies interactive approvals in unattended modes', async () => {
    const diagnostics: string[] = []
    const options = qoderQueryOptions(
      runSpec(),
      new AbortController(),
      value => diagnostics.push(value),
    )
    expect(options.persistSession).toBe(false)
    expect(options.cwd).toBe(process.cwd())
    const decision = await options.canUseTool?.('Bash', { cmd: 'ls' }, {
      toolUseID: 'id-1',
      signal: new AbortController().signal,
    })
    expect(decision).toMatchObject({ behavior: 'deny', toolUseID: 'id-1' })
    expect(diagnostics[0]).toMatch(/tool permission; decision: denied/)
    const elicitation = await options.onElicitation?.(
      { serverName: 's', message: 'm' },
      { signal: new AbortController().signal },
    )
    expect(elicitation).toMatchObject({ action: 'decline' })
    expect(diagnostics[1]).toMatch(/MCP elicitation; decision: declined/)
  })

  it('skips approval callbacks only in bypass modes', () => {
    for (const permissionMode of ['bypassPermissions', 'yolo'] as const) {
      const options = qoderQueryOptions(
        runSpec({ permissionMode }),
        new AbortController(),
        () => {},
      )
      expect(options.canUseTool).toBeUndefined()
      expect(options.allowDangerouslySkipPermissions).toBe(true)
    }
  })
})

describe('qoderAuthOptions', () => {
  it('maps configured sources onto SDK auth options', () => {
    expect(qoderAuthOptions('pat-env')).toMatchObject({
      type: 'accessToken',
      accessToken: { envVar: 'QODER_PERSONAL_ACCESS_TOKEN' },
    })
    expect(qoderAuthOptions('pat-env', 'MY_QODER_PAT')).toMatchObject({
      accessToken: { envVar: 'MY_QODER_PAT' },
    })
    expect(qoderAuthOptions('qodercli')).toMatchObject({ type: 'qodercli' })
  })
})

describe('nativePermissionMode', () => {
  it('translates the unattended default onto the daemon-supported set', () => {
    expect(nativePermissionMode('dontAsk')).toBe('default')
    expect(nativePermissionMode('acceptEdits')).toBe('acceptEdits')
    expect(nativePermissionMode('bypassPermissions')).toBe('bypassPermissions')
  })
})

describe('qoderStartupFailure', () => {
  it('marks token-missing failures as auth', () => {
    const cause = new Error('env var not configured')
    cause.name = 'AuthAccessTokenEnvVarError'
    const failure = qoderStartupFailure('daemon-start', cause)
    expect(failure.message).toMatch(/stage: daemon-start; category: auth/)
  })

  it('hides other startup causes behind fixed facts', () => {
    const failure = qoderStartupFailure('query-start', new Error('secret detail'))
    expect(failure.message).toMatch(/stage: query-start; category: unknown/)
    expect(failure.message).not.toContain('secret detail')
  })
})

describe('startQoderRun', () => {
  it('publishes a completed run and disposes its daemon', async () => {
    const daemon = fakeDaemon()
    const query = fakeQuery([textResult()])
    mocks.startDaemon.mockResolvedValue(daemon)
    mocks.query.mockReturnValue(query)

    const run = await startQoderRun(startRequest('do it'), runSpec())
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'the answer' }],
      stopReason: 'completed',
    })

    expect(mocks.startDaemon).toHaveBeenCalledOnce()
    const daemonOptions = mocks.startDaemon.mock.calls[0][0]
    expect(daemonOptions.auth).toMatchObject({ type: 'accessToken' })
    expect(daemonOptions.launchMode).toBe('worker')
    expect(daemonOptions.env).toMatchObject({ PATH: process.env.PATH })
    expect(mocks.query).toHaveBeenCalledOnce()
    const queryArguments = mocks.query.mock.calls[0][0]
    expect(queryArguments.prompt).toBe('do it')
    expect(queryArguments.options.daemon).toBe(daemon)
    expect(queryArguments.options.cwd).toBe(process.cwd())

    await run.dispose()
    expect(query.close).toHaveBeenCalledOnce()
    expect(daemon.stop).toHaveBeenCalledOnce()
  })

  it('rejects startup before publication when the daemon fails', async () => {
    mocks.startDaemon.mockRejectedValue(new Error('no runtime'))
    await expect(startQoderRun(startRequest('x'), runSpec()))
      .rejects.toThrow(/stage: daemon-start/)
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('stops a started daemon when query creation fails', async () => {
    const daemon = fakeDaemon()
    mocks.startDaemon.mockResolvedValue(daemon)
    mocks.query.mockImplementation(() => {
      throw new Error('bad options')
    })
    await expect(startQoderRun(startRequest('x'), runSpec()))
      .rejects.toThrow(/stage: query-start/)
    expect(daemon.stop).toHaveBeenCalledOnce()
  })

  it('flattens a mid-run daemon failure into an error result', async () => {
    const daemon = fakeDaemon()
    mocks.startDaemon.mockResolvedValue(daemon)
    const failingQuery = {
      close: vi.fn(async () => {}),
      interrupt: vi.fn(async () => undefined),
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
        daemon.fail(new Error('daemon died'))
        // A dead daemon never delivers further frames; the stream hangs.
        await new Promise<never>(() => {})
      },
    }
    mocks.query.mockReturnValue(failingQuery)

    const run = await startQoderRun(startRequest('x'), runSpec())
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toMatch(/stage: process; category: process/)
    await run.dispose()
  })

  it('flattens a terminal SDK error into a diagnostic', async () => {
    mocks.startDaemon.mockResolvedValue(fakeDaemon())
    mocks.query.mockReturnValue(fakeQuery([
      textResult({
        subtype: 'error_max_turns',
        errors: ['turn cap'],
        result: undefined,
      }),
    ]))

    const onError = vi.fn()
    const run = await startQoderRun(startRequest('x'), runSpec({ onError }))
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toMatch(/stage: query-run; category: limit/)
    expect(onError).toHaveBeenCalledOnce()
    await run.dispose()
  })

  it('settles an aborted run, removes the listener, and still disposes', async () => {
    const daemon = fakeDaemon()
    const { query, open } = gatedQuery()
    mocks.startDaemon.mockResolvedValue(daemon)
    mocks.query.mockReturnValue(query)
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')

    const run = await startQoderRun(startRequest('x', controller), runSpec())
    controller.abort()
    open()
    await expect(run.result).resolves.toMatchObject({ stopReason: 'aborted' })
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))

    await run.dispose()
    expect(query.close).toHaveBeenCalledOnce()
    expect(daemon.stop).toHaveBeenCalledOnce()
  })

  it('rejects before daemon startup when the request is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(startQoderRun(startRequest('x', controller), runSpec()))
      .rejects.toThrow(/aborted before daemon startup/)
    expect(mocks.startDaemon).not.toHaveBeenCalled()
  })

  it('rolls back the daemon when abort races run publication', async () => {
    const daemon = fakeDaemon()
    const controller = new AbortController()
    mocks.startDaemon.mockImplementation(async () => {
      controller.abort()
      return daemon
    })
    mocks.query.mockReturnValue(fakeQuery([textResult()]))

    const failure = await startQoderRun(startRequest('x', controller), runSpec())
      .then((run) => run, (error: unknown) => error)
    expect((failure as Error).message).toMatch(/stage: query-start/)
    expect((failure as Error).cause).toBeInstanceOf(Error)
    expect(((failure as Error).cause as Error).message).toMatch(/aborted before run publication/)
    expect(daemon.stop).toHaveBeenCalledOnce()
  })

  it('removes the abort listener and reports startup failures', async () => {
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    mocks.startDaemon.mockRejectedValue(new Error('no runtime'))
    const onError = vi.fn()

    await expect(startQoderRun(startRequest('x', controller), runSpec({ onError })))
      .rejects.toThrow(/stage: daemon-start/)
    expect(onError).toHaveBeenCalledOnce()
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('fails loudly when teardown cannot stop the daemon', async () => {
    const daemon = fakeDaemon()
    mocks.startDaemon.mockResolvedValue(daemon)
    mocks.query.mockReturnValue(fakeQuery([textResult()]))
    const onError = vi.fn()

    const run = await startQoderRun(startRequest('x'), runSpec({ onError }))
    await run.result
    daemon.stop.mockRejectedValueOnce(new Error('stop refused'))
    await expect(run.dispose()).rejects.toThrow(/stage: teardown/)
    expect(daemon.stop).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledOnce()
  })

  it('aggregates double teardown failures and still attempts both', async () => {
    const daemon = fakeDaemon()
    const query = fakeQuery([textResult()])
    mocks.startDaemon.mockResolvedValue(daemon)
    mocks.query.mockReturnValue(query)
    const onError = vi.fn()

    const run = await startQoderRun(startRequest('x'), runSpec({ onError }))
    await run.result
    query.close.mockRejectedValueOnce(new Error('close refused'))
    daemon.stop.mockRejectedValueOnce(new Error('stop refused'))
    const failure = await run.dispose().catch((error: unknown) => error)
    expect((failure as Error).message).toMatch(/stage: teardown/)
    expect((failure as Error).cause).toBeInstanceOf(AggregateError)
    const aggregate = (failure as Error).cause as AggregateError
    expect(aggregate.message).toMatch(/Qoder teardown failures/)
    expect(aggregate.errors.map((error) => (error as Error).message))
      .toEqual(expect.arrayContaining(['close refused', 'stop refused']))
    expect(query.close).toHaveBeenCalledOnce()
    expect(daemon.stop).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledOnce()
  })

  it('aggregates rollback failures when daemon stop rejects during startup', async () => {
    const daemon = fakeDaemon()
    mocks.startDaemon.mockResolvedValue(daemon)
    mocks.query.mockImplementation(() => {
      throw new Error('bad options')
    })
    daemon.stop.mockRejectedValueOnce(new Error('stop refused'))
    const onError = vi.fn()

    const failure = await startQoderRun(startRequest('x'), runSpec({ onError }))
      .then((run) => run, (error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).message).toMatch(/stage: query-start/)
    expect((failure as AggregateError).message).toMatch(/stop refused/)
    expect(onError).toHaveBeenCalledOnce()
  })
})
