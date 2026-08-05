/**
 * Tests for GIT_STATUS_PROVENANCE_NOTE — the addendum that corrects the
 * `claude_code` preset's claim that its `gitStatus` block describes "the start
 * of the conversation".
 *
 * Meridian issues one `query()` per turn, so the SDK recomputes that block
 * every turn while still labelling it the conversation's starting state. The
 * model then reads files it created in earlier turns as pre-existing work and
 * reports having destroyed the user's uncommitted changes (#694).
 */
import { describe, it, expect } from "bun:test"
import { buildQueryOptions, GIT_STATUS_PROVENANCE_NOTE, type QueryContext } from "../proxy/query"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS, MCP_SERVER_NAME, ALLOWED_MCP_TOOLS } from "../proxy/tools"

/** Mirrors the shared context helper in query.test.ts. */
function ctx(overrides: Partial<QueryContext> = {}): QueryContext {
  return {
    prompt: "Hello",
    model: "sonnet[1m]",
    workingDirectory: "/tmp/test",
    systemContext: "",
    claudeExecutable: "/usr/bin/claude",
    passthrough: false,
    stream: false,
    sdkAgents: {},
    cleanEnv: {},
    envOverrides: undefined,
    hasDeferredTools: false,
    isUndo: false,
    blockedTools: BLOCKED_BUILTIN_TOOLS,
    incompatibleTools: CLAUDE_CODE_ONLY_TOOLS,
    mcpServerName: MCP_SERVER_NAME,
    allowedMcpTools: ALLOWED_MCP_TOOLS,
    ...overrides,
  }
}

/** The append string for a request that resolves to the preset. */
function presetAppend(overrides: Partial<QueryContext> = {}): string {
  const { options } = buildQueryOptions(ctx(overrides))
  const sp = options.systemPrompt
  if (typeof sp !== "object" || sp === null) {
    throw new Error(`expected preset object, got ${JSON.stringify(sp)}`)
  }
  return (sp as { append?: string }).append ?? ""
}

describe("GIT_STATUS_PROVENANCE_NOTE", () => {
  it("contradicts the preset's 'start of the conversation' claim", () => {
    // The note is useless unless it names the specific false claim it corrects;
    // a vague "git status may be stale" would not tell the model which of two
    // contradictory sources to believe.
    expect(GIT_STATUS_PROVENANCE_NOTE).toContain("start of the conversation")
    expect(GIT_STATUS_PROVENANCE_NOTE).toContain("recomputed at the start of every turn")
  })

  it("tells the model the block is not evidence of provenance", () => {
    // This is the inference that produced #694: the model treated the block as
    // proof the files predated its own work.
    expect(GIT_STATUS_PROVENANCE_NOTE).toContain("not")
    expect(GIT_STATUS_PROVENANCE_NOTE).toContain("predates the conversation")
    expect(GIT_STATUS_PROVENANCE_NOTE).toContain("earlier turns")
  })

  it("points at what to trust instead", () => {
    expect(GIT_STATUS_PROVENANCE_NOTE).toContain("conversation history")
    expect(GIT_STATUS_PROVENANCE_NOTE).toContain("git status")
  })

  it("is wrapped in the meridian-note tag used by the cwd addendum", () => {
    expect(GIT_STATUS_PROVENANCE_NOTE).toContain("<meridian-note>")
    expect(GIT_STATUS_PROVENANCE_NOTE).toContain("</meridian-note>")
  })
})

describe("buildQueryOptions — gitStatus note placement", () => {
  it("appends the note when the preset is used with no client system prompt", () => {
    // The bug does not require a client system prompt, so neither can the fix.
    const append = presetAppend({ codeSystemPrompt: true })
    expect(append).toContain(GIT_STATUS_PROVENANCE_NOTE.trim())
  })

  it("keeps the note in the preset append when the client also sent a system prompt", () => {
    const result = buildQueryOptions(ctx({ codeSystemPrompt: true, systemContext: "You are helpful." }))
    const sp = result.options.systemPrompt
    if (typeof sp !== "object" || sp === null) {
      throw new Error(`expected preset object, got ${JSON.stringify(sp)}`)
    }
    const append = (sp as { append?: string }).append ?? ""

    // Large SDK systemPrompt values can be rejected by the subscription
    // transport, so client instructions travel in the prompt. The preset
    // append is reserved for Meridian's own correction.
    expect(append).not.toContain("You are helpful.")
    expect(append).toContain(GIT_STATUS_PROVENANCE_NOTE.trim())
    expect(result.prompt).toContain("<client-system-instructions>\nYou are helpful.")
  })

  it("keeps the preset addendum independent of the client system prompt", () => {
    const append = presetAppend({ codeSystemPrompt: true, systemContext: "You are helpful." })
    expect(append).toBe(GIT_STATUS_PROVENANCE_NOTE)
  })

  it("keeps the note after the cwd override, which must stay the first env block", () => {
    // buildCwdNote documents that its <env> block has to come first so the
    // subprocess does not inject a competing one; the git note must not
    // displace it.
    const append = presetAppend({
      codeSystemPrompt: true,
      workingDirectory: "/srv/proxy",
      clientWorkingDirectory: "/Users/alice/app",
    })
    expect(append.indexOf("<env>")).toBeLessThan(append.indexOf("gitStatus"))
  })

  it("omits the note when the preset is not used", () => {
    // Without the preset there is no gitStatus block, so the note would be
    // describing context the model cannot see.
    const result = buildQueryOptions(ctx({
      codeSystemPrompt: false,
      systemContext: "You are helpful.",
    }))
    // Keep the SDK's systemPrompt explicitly empty so it cannot restore the
    // preset; the client context remains in the request prompt.
    expect(result.options.systemPrompt).toBe("")
    expect(result.prompt).toContain("<client-system-instructions>\nYou are helpful.")
  })

  it("still forces an empty system prompt when the preset is off with nothing to append", () => {
    // Regression guard for the #489 follow-up: `{}` would let the SDK
    // reintroduce the preset.
    const { options } = buildQueryOptions(ctx({ codeSystemPrompt: false }))
    expect(options.systemPrompt).toBe("")
  })

  it("applies to passthrough requests, where the bug was reported", () => {
    // #694 came from OpenCode, which defaults to passthrough. Passthrough turns
    // are exactly the ones that re-query most often (once per tool round-trip),
    // so they refresh the block most often.
    const append = presetAppend({ codeSystemPrompt: true, passthrough: true })
    expect(append).toContain(GIT_STATUS_PROVENANCE_NOTE.trim())
  })

  it("applies on resume, not just on fresh sessions", () => {
    // A resumed turn is where the claim is provably false.
    const append = presetAppend({ codeSystemPrompt: true, resumeSessionId: "abc-123" })
    expect(append).toContain(GIT_STATUS_PROVENANCE_NOTE.trim())
  })
})
