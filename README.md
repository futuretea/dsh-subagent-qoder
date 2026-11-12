# dsh-subagent-qoder

One-shot [Qoder](https://qoder.com) subagent provider for DeepSeek Harness, built on the official [`@qoder-ai/qoder-agent-sdk`](https://docs.qoder.com/cli/sdk/overview).

Each accepted delegation starts a private SDK daemon with one daemon-bound query in the delegating Session's workspace. The SDK owns the qodercli runtime process; the provider observes it through daemon failure notifications and stops the daemon on teardown. Interactive approvals are never surfaced to a human: unattended modes deny them and record a diagnostic.

## Install

Requires the Qoder TypeScript SDK runtime (Node.js 18+; dsh itself requires Node 24+). Authenticate with a Qoder Personal Access Token generated at <https://qoder.com/account/integrations>:

```sh
export QODER_PERSONAL_ACCESS_TOKEN="<your-qoder-personal-access-token>"
```

Add the bundle to a dsh profile:

```sh
dsh plugin --profile <name> add /path/to/dsh-subagent-qoder
```

The bundle patch inserts the `qoder` provider and mounts the shared `subagent_qoder` tool for it. Consecutive delegations each start a fresh daemon run; nothing persists between them.

## Configuration

Provider rows in `cordis.yml` accept:

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `qoder` | Name registered on `ctx.subagents` |
| `model` | native settings | Native Qoder model fixed for this instance |
| `auth` | `pat-env` | `pat-env` reads the PAT env var; `qodercli` reuses local `qodercli login` state |
| `authEnvVar` | `QODER_PERSONAL_ACCESS_TOKEN` | PAT environment variable name for `pat-env` |
| `env` | `{}` | Explicit entries layered over the credential-scrubbed parent environment for the daemon-owned child process |
| `permissionMode` | `dontAsk` | Native non-interactive permission mode |

Permission modes map to Qoder SDK modes: `default`, `acceptEdits`, `dontAsk`, `auto`, `bypassPermissions` (alias `yolo`). Daemon-bound queries accept only `default`, `acceptEdits`, `auto`, and `bypassPermissions`; the `dontAsk` default is translated to `default` plus this provider's approval-deny callback, preserving the unattended behavior. `bypassPermissions`/`yolo` skip permission checks and are only appropriate inside an external isolation boundary.

The PAT is read from the dsh host process environment (or `env` entries) by the SDK and written to a one-time auth payload; it never lands in the child process environment or the session log.

## Develop

```sh
pnpm install     # links dsh peers to a local deepseek-harness checkout
pnpm typecheck
pnpm test
pnpm build
```

The `@deepseek-ai/dsh-*` dev dependencies in `package.json` are `link:` paths to a harness checkout; adjust them to your checkout location. Real-API checks need `QODER_PERSONAL_ACCESS_TOKEN`.

## Known limitations

- The daemon runs the SDK-bundled worker runtime (`launchMode: 'worker'`, pinned to the SDK version). A system-installed `qodercli` is never used; a global install with a mismatched version would break the default `process` launch mode.
- The SDK's daemon owns the qodercli process; dsh does not apply its subprocess termination ladder or sandbox to it. Teardown asks the daemon to stop and fails loudly if it refuses.
- Single text task per delegation: no continuation, resume, structured output, progress stream, or side-effect rollback.
- Startup failures before publication expose only fixed stage/category facts; native causes stay in the host log.
