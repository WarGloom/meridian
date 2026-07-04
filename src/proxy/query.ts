/**
 * SDK query options builder.
 *
 * Centralizes the construction of query() options, eliminating duplication
 * between the streaming and non-streaming paths in server.ts.
 */

import { join } from "node:path"
import type { Options, OutputFormat, SdkBeta, SettingSource } from "@anthropic-ai/claude-agent-sdk"
import { createOpencodeMcpServer } from "../mcpTools"
import { createPassthroughMcpServer, PASSTHROUGH_MCP_NAME } from "./passthroughTools"
import type { Effort } from "./effort"

/**
 * Return a copy of `env` with `CLAUDE_CONFIG_DIR` removed. Used by the
 * sharedMemory branch — see the comment at the env construction site.
 *
 * Skips the strip when `CLAUDE_CODE_OAUTH_TOKEN` is present: oauth-token
 * profiles deliberately pin a per-profile config dir so the SDK's
 * 401-recovery cannot silently fall back to host `~/.claude` credentials
 * and swap a refreshed token in for the env-provided one (closes #446).
 * Stripping the pin would defeat that isolation.
 *
 * Pure function: never mutates the input.
 */
function stripConfigDir(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (!("CLAUDE_CONFIG_DIR" in env)) return env
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return env
  const out = { ...env }
  delete out.CLAUDE_CONFIG_DIR
  return out
}

export interface QueryContext {
  /** The prompt to send (text or async iterable for multimodal) */
  prompt: string | AsyncIterable<any>
  /** Resolved Claude model name */
  model: string
  /** SDK subprocess working directory — must exist on the proxy host. */
  workingDirectory: string
  /**
   * Client-local working directory (as reported in the request). May not
   * exist on the proxy host. When this differs from workingDirectory the
   * system prompt is augmented with a note directing the model to refer
   * to file paths using the client's path rather than the proxy's.
   */
  clientWorkingDirectory?: string
  /** System context text (may be empty) */
  systemContext: string
  /** Path to Claude executable */
  claudeExecutable: string
  /** Whether passthrough mode is enabled */
  passthrough: boolean
  /** Whether this is a streaming request */
  stream: boolean
  /** SDK agent definitions extracted from tool descriptions */
  sdkAgents: Record<string, any>
  /** Passthrough MCP server (if passthrough mode + tools present) */
  passthroughMcp?: ReturnType<typeof createPassthroughMcpServer>
  /** Cleaned environment variables (API keys stripped) */
  cleanEnv: Record<string, string | undefined>
  /** Per-request env overrides that must win over inherited env */
  envOverrides?: Record<string, string | undefined>
  /** Whether any passthrough tools use deferred loading */
  hasDeferredTools: boolean
  /** SDK session ID for resume (if continuing a session) */
  resumeSessionId?: string
  /** The resumed passthrough session already has this exact client context. */
  skipClientContextOnResume?: boolean
  /** Whether this is an undo operation */
  isUndo: boolean
  /** UUID to rollback to for undo operations */
  undoRollbackUuid?: string
  /** Fork the resumed session instead of attaching to it (#630 busy-session
   *  fallback — the original stays registered as a bg agent; the fork gets a
   *  fresh id with the full history). */
  forkSession?: boolean
  /** SDK hooks (PreToolUse etc.) */
  sdkHooks?: any
  /** Blocked SDK built-in tools (from pipeline) */
  blockedTools: readonly string[]
  /** Agent-incompatible tools (from pipeline) */
  incompatibleTools: readonly string[]
  /** MCP server name for this adapter */
  mcpServerName: string
  /** Allowed MCP tools (from pipeline) */
  allowedMcpTools: readonly string[]
  /** Callback to receive stderr lines from the Claude subprocess */
  onStderr?: (line: string) => void
  /** Effort level — controls thinking depth (low/medium/high/xhigh/max) */
  effort?: Effort
  /** Thinking configuration — adaptive, enabled with budget, or disabled */
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens?: number } | { type: 'disabled' }
  /** API-side task budget in tokens — model paces tool use within this limit */
  taskBudget?: { total: number }
  /** Native JSON-schema output contract for the Claude Agent SDK */
  outputFormat?: OutputFormat
  /** Beta features to enable */
  betas?: string[]
  /** SDK setting sources — controls CLAUDE.md and user settings loading */
  settingSources?: SettingSource[]
  /** Use the Claude Code system prompt preset */
  codeSystemPrompt?: boolean
  /** Include the client agent's system prompt */
  clientSystemPrompt?: boolean
  /** Where to place the client system prompt when the Claude Code preset is disabled. */
  clientSystemPromptPlacement?: "prompt" | "systemPrompt"
  /** Enable auto-memory (read + write across sessions) */
  memory?: boolean
  /** Enable background memory consolidation (dreaming) */
  dreaming?: boolean
  /** Share memory directory with Claude Code (~/.claude) */
  sharedMemory?: boolean
  /** Per-request cost cap in USD */
  maxBudgetUsd?: number
  /** Fallback model when primary fails */
  fallbackModel?: string
  /** Enable SDK debug logging */
  sdkDebug?: boolean
  /** Additional directories Claude can access */
  additionalDirectories?: string[]
  /** Advisor model for server-side advisor tool support */
  advisorModel?: string
}

/**
 * Build the options object for the Claude Agent SDK query() call.
 * This is called identically from both streaming and non-streaming paths,
 * with the only difference being `includePartialMessages` for streaming.
 */
export interface BuildQueryResult {
  prompt: QueryContext["prompt"]
  options: Options
}

const PASSTHROUGH_MAX_TURNS = 30

/**
 * NOTE: agent-specific (passthrough mode).
 *
 * maxTurns is a safety ceiling for SDK agent/tool round trips, not an exact
 * phase budget. Passthrough still needs enough room for variable SDK internals:
 * blocked-tool handoff, session resume, deferred ToolSearch, multimodal setup,
 * and optional advisor turns. Exact phase counting caused real screenshot flows
 * to fail with "Reached maximum number of turns (4)" before a useful tool call.
 */
function computePassthroughMaxTurns(): number {
  return PASSTHROUGH_MAX_TURNS
}

/**
 * Build an addendum that tells the model which path belongs to the real user.
 * Applied when the SDK subprocess runs in one directory on the proxy host but
 * the client is working in a different directory on their own machine
 * (typical of a remote Claude Code → network-proxy setup). Without this note
 * the SDK's env block leaks `sdkCwd` into the model's context and Claude
 * reports that as its working directory.
 */
export function buildCwdNote(sdkCwd: string, clientCwd?: string): string {
  if (!clientCwd || clientCwd === sdkCwd) return ""
  // Emit in the `<env>Working directory: …</env>` shape the Claude Code
  // subprocess uses itself, so it doesn't auto-inject a second env block
  // pointing at its own process.cwd() (which would be the proxy host path).
  // Placed at the top of the append so it's the first env block the model
  // sees. The subsequent notice tells the model to prefer this over any
  // contradictory path that might slip through later in the context.
  return (
    `\n\n<env>\n` +
    `Working directory: ${clientCwd}\n` +
    `</env>\n` +
    `<meridian-note>\n` +
    `You are reached through a proxy. The subprocess running you resides at ` +
    `"${sdkCwd}" on the proxy host, but that is not the user's working directory. ` +
    `Always treat "${clientCwd}" as the working directory when referring to files or paths.\n` +
    `</meridian-note>`
  )
}

function buildClientContext(systemContext: string | undefined, includeClient: boolean): string | undefined {
  if (!includeClient || !systemContext) return undefined
  return `<client-system-instructions>\n${systemContext}\n</client-system-instructions>`
}

function prependClientContextToPrompt(
  prompt: QueryContext["prompt"],
  clientContext: string | undefined,
): QueryContext["prompt"] {
  if (!clientContext) return prompt
  if (typeof prompt === "string") {
    return `${clientContext}\n\n${prompt}`
  }

  return (async function* () {
    yield {
      type: "user" as const,
      message: { role: "user" as const, content: clientContext },
      parent_tool_use_id: null,
    }
    yield* prompt
  })()
}

function resolveSystemPrompt(
  hasClientContext: boolean,
  clientSystemPromptOption: string | undefined,
  passthrough: boolean,
  settingSources: SettingSource[] | undefined,
  codeSystemPrompt: boolean | undefined,
  cwdNote: string,
): { systemPrompt?: string | { type: "preset"; preset: "claude_code"; append?: string } } {
  const hasSettings = settingSources != null && settingSources.length > 0
  const usePreset = codeSystemPrompt ?? (hasSettings || (!passthrough && hasClientContext))
  const append = cwdNote || undefined

  if (usePreset) {
    return append
      ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append } }
      : { systemPrompt: { type: "preset" as const, preset: "claude_code" as const } }
  }
  if (clientSystemPromptOption) {
    return append ? { systemPrompt: `${clientSystemPromptOption}\n\n${append}` } : { systemPrompt: clientSystemPromptOption }
  }
  if (append) return { systemPrompt: append }
  // Defensive: when `codeSystemPrompt: false` is explicit and there's
  // nothing to append, force an empty-string system prompt so the SDK
  // can't fall back to the claude_code preset. Returning `{}` would leave
  // `systemPrompt` undefined and let downstream defaults reintroduce the
  // preset. (#489 follow-up — low impact in practice since most callers
  // send a `system` field; belt-and-suspenders for the empty case.)
  if (codeSystemPrompt === false) return { systemPrompt: "" }
  return {}
}

export function buildQueryOptions(ctx: QueryContext, abortController?: AbortController): BuildQueryResult {
  const {
    prompt, model, workingDirectory, clientWorkingDirectory, systemContext, claudeExecutable,
    passthrough, stream, sdkAgents, passthroughMcp, cleanEnv, hasDeferredTools,
    resumeSessionId, skipClientContextOnResume, isUndo, undoRollbackUuid, forkSession, sdkHooks, blockedTools, incompatibleTools,
    mcpServerName, allowedMcpTools, onStderr,
    effort, thinking, taskBudget, outputFormat, betas, settingSources, codeSystemPrompt, clientSystemPrompt, clientSystemPromptPlacement,
    memory, dreaming, sharedMemory, maxBudgetUsd, fallbackModel, sdkDebug, additionalDirectories, advisorModel,
  } = ctx
  const cwdNote = buildCwdNote(workingDirectory, clientWorkingDirectory)
  const includeClient = clientSystemPrompt ?? true
  const useClientSystemPromptOption =
    clientSystemPromptPlacement === "systemPrompt" &&
    codeSystemPrompt !== true &&
    includeClient &&
    systemContext.trim().length > 0
  const clientContext = buildClientContext(systemContext, includeClient)
  // The resumed SDK session already contains the client instructions from its
  // first turn. Re-injecting them into every continuation appends another full
  // copy to the conversation, which can consume tens of thousands of tokens
  // per client-side tool result. Fresh and forked sessions still receive the
  // current client context.
  const resumeHasClientContext = Boolean(
    passthrough && resumeSessionId && !isUndo && skipClientContextOnResume,
  )
  const promptClientContext = resumeHasClientContext || useClientSystemPromptOption ? undefined : clientContext
  const clientSystemPromptOption = resumeHasClientContext || !useClientSystemPromptOption ? undefined : systemContext

  const allBlockedTools = [...blockedTools, ...incompatibleTools]

  return {
    prompt: prependClientContextToPrompt(prompt, promptClientContext),
    options: {
      // Force Node as the executable. The claude-agent-sdk auto-detects Bun
      // via process.versions.bun and defaults to spawning `bun cli.js`.
      // Hosts like OpenCode embed Bun, so the check fires even when `bun`
      // is not in PATH — causing subprocess spawns to fail.
      executable: "node" as const,
      maxTurns: passthrough ? computePassthroughMaxTurns() : 200,
      cwd: workingDirectory,
      model,
      pathToClaudeCodeExecutable: claudeExecutable,
      ...(abortController ? { abortController } : {}),
      ...(stream ? { includePartialMessages: true } : {}),
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      ...resolveSystemPrompt(clientContext != null, clientSystemPromptOption, passthrough, settingSources, codeSystemPrompt, cwdNote),
      ...(passthrough
        ? {
            // Strip the SDK's ~25k-token built-in tool catalog from the
            // upstream request. Passthrough mode never intends to invoke
            // SDK built-ins (Read/Write/Bash/etc.) — those are the calling
            // client's responsibility. `disallowedTools` below blocks
            // invocation at runtime; it does NOT remove the definitions
            // from the upstream payload. Setting `tools: []` elides the
            // catalog from the request body. Closes #489 (diagnosis by
            // @albe-jj).
            tools: [],
            disallowedTools: [...allBlockedTools],
            ...(passthroughMcp ? {
              allowedTools: [...passthroughMcp.toolNames],
              mcpServers: { [PASSTHROUGH_MCP_NAME]: passthroughMcp.server },
            } : {}),
          }
        : {
            disallowedTools: [...allBlockedTools],
            allowedTools: [...allowedMcpTools],
            mcpServers: { [mcpServerName]: createOpencodeMcpServer() },
          }),
      plugins: [],
      // #634: `settings` (the --settings flag domain) is independent of
      // `settingSources` (file domains) — never couple them. The memory
      // controls must reach the SDK even when no setting files are loaded;
      // gating them on settingSources silently re-enabled auto-memory (the
      // SDK's built-in default) whenever claudeMd was "off".
      settings: {
        autoMemoryEnabled: memory ?? true,
        autoDreamEnabled: dreaming ?? false,
      },
      // #634/#490: always explicit. Empty array → SDK emits
      // `--setting-sources=` → subprocess loads nothing. Omitting the key
      // makes claude-code fall back to its built-in default (user + project
      // + local) and slurp CLAUDE.md from the PROXY HOST's cwd into the
      // system prompt regardless of claudeMd:"off" — #490 fixed this for
      // passthrough; this extends the same guarantee to every adapter.
      settingSources: settingSources ?? [],
      ...(onStderr ? { stderr: onStderr } : {}),
      env: {
        // sharedMemory: the user wants the SDK to use Claude Code's default
        // config dir so memories sync. Counter-intuitively we DON'T set
        // CLAUDE_CONFIG_DIR=$HOME/.claude here — explicitly setting it (even
        // to the default value) changes the SDK's Keychain lookup key and
        // breaks OAuth (issue #453, upstream anthropics/claude-code#20553).
        // Instead, strip any inherited custom CLAUDE_CONFIG_DIR from the
        // profile env so the SDK falls back to its own default. That achieves
        // the "share memory with Claude Code" intent without poisoning
        // Keychain auth.
        ...(sharedMemory ? stripConfigDir(cleanEnv) : cleanEnv),
        ENABLE_TOOL_SEARCH: hasDeferredTools ? "true" : "false",
        ...(passthrough ? { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } : {}),
        // Passthrough: suppress the CLI's "# Scratchpad Directory" context
        // block (#627). It advertises a PROXY-HOST path, but the CLIENT
        // executes the tools — OpenCode 1.18+ permission-blocks writes to
        // that alien path (external_directory), dead-ending headless runs.
        // The CLI skips the block when CLAUDE_CODE_SESSION_KIND=bg — its own
        // headless-background mode, which is semantically what this
        // subprocess is. All other "bg" effects are TUI rendering (no TUI
        // here) or CLAUDE_JOB_DIR-gated bookkeeping (we don't set it) —
        // audited against the bundled CLI. Kill switch:
        // MERIDIAN_SUPPRESS_SCRATCHPAD=0. Profile envOverrides spread below
        // and win if the operator sets an explicit value.
        ...(passthrough && process.env.MERIDIAN_SUPPRESS_SCRATCHPAD !== "0"
          ? { CLAUDE_CODE_SESSION_KIND: "bg" }
          : {}),
        // When running as root (Docker, Unraid, NAS), set IS_SANDBOX=1 to
        // bypass the SDK's root check. Without this, the SDK exits with:
        // "--dangerously-skip-permissions cannot be used with root/sudo"
        // See: https://github.com/rynfar/meridian/issues/256
        ...(process.getuid?.() === 0 ? { IS_SANDBOX: "1" } : {}),
        ...ctx.envOverrides,
      },
      ...(Object.keys(sdkAgents).length > 0 ? { agents: sdkAgents } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(isUndo || forkSession ? { forkSession: true } : {}),
      ...(isUndo && undoRollbackUuid ? { resumeSessionAt: undoRollbackUuid } : {}),
      ...(sdkHooks ? { hooks: sdkHooks } : {}),
      ...(effort ? { effort } : {}),
      ...(thinking ? { thinking } : {}),
      ...(taskBudget ? { taskBudget } : {}),
      ...(outputFormat ? { outputFormat } : {}),
      ...(betas && betas.length > 0 ? { betas: betas as SdkBeta[] } : {}),
      ...(maxBudgetUsd && maxBudgetUsd > 0 ? { maxBudgetUsd } : {}),
      ...(fallbackModel ? { fallbackModel } : {}),
      ...(sdkDebug ? { debug: true } : {}),
      ...(additionalDirectories && additionalDirectories.length > 0 ? { additionalDirectories } : {}),
      ...(advisorModel ? { advisorModel } : {}),
    }
  }
}
