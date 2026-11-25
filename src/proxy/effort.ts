/**
 * Reasoning effort levels and normalization.
 *
 * The Claude Code SDK `--effort` flag accepts a fixed vocabulary. Clients send
 * the effort under several keys (`effort`, `x-opencode-effort`, the standard
 * OpenAI `reasoning_effort`, or an Anthropic-style `output_config.effort`), and
 * not every value they send is valid for Claude — OpenAI notably offers
 * `"minimal"`, which the SDK rejects. normalizeEffort gates the value so an
 * unknown effort falls back to the model default (undefined) rather than
 * erroring the whole request at the SDK boundary.
 *
 * Pure module — no I/O, no imports from server/session.
 */

export const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

export type Effort = (typeof VALID_EFFORTS)[number]

const AGY_CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5"] as const
type AgyClaudeEffort = "low" | "medium" | "high"
export type AgyClaudeModelSlug = `${(typeof AGY_CLAUDE_MODELS)[number]}-${AgyClaudeEffort}`

export function isAgyClaudeModel(model: unknown): model is (typeof AGY_CLAUDE_MODELS)[number] {
  return AGY_CLAUDE_MODELS.some(id => id === model)
}

export function readClientEffort(input: {
  readonly header: string | undefined
  readonly body: Readonly<Record<string, unknown>>
  readonly currentSystemOverride?: boolean
}): unknown {
  const { header, body } = input
  const top = body.output_config
  const topEffort = typeof top === "object" && top !== null && "effort" in top ? top.effort : undefined
  const direct = input.currentSystemOverride ? header ?? body.effort ?? body.reasoning_effort : header || body.effort || body.reasoning_effort || topEffort
  if (input.currentSystemOverride ? direct !== undefined : normalizeEffort(direct)) return direct
  const messages: readonly unknown[] = Array.isArray(body.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "system") continue
    const cfg = ("output_config" in message ? message.output_config : undefined)
      ?? ("outputConfig" in message ? message.outputConfig : undefined)
    if (cfg && typeof cfg === "object" && "effort" in cfg && (input.currentSystemOverride || normalizeEffort(cfg.effort))) return cfg.effort
  }
  return input.currentSystemOverride ? topEffort : direct
}

export function selectAgyClaudeModel(model: unknown, effort: unknown, catalog: readonly string[]): AgyClaudeModelSlug | undefined {
  const base = AGY_CLAUDE_MODELS.find(id => id === model)
  const level = effort === undefined ? "high" : effort
  if (!base || (level !== "low" && level !== "medium" && level !== "high")) return undefined
  const slug: AgyClaudeModelSlug = `${base}-${level}`
  return catalog.includes(slug) ? slug : undefined
}

export function parseAgyClaudeModelSlug(value: string): AgyClaudeModelSlug | undefined {
  const separator = value.lastIndexOf("-")
  if (separator < 0) return undefined
  return selectAgyClaudeModel(value.slice(0, separator), value.slice(separator + 1), [value])
}

/**
 * Return the value if it is a valid Claude effort level, else undefined.
 * Case-sensitive: the SDK expects lowercase.
 */
export function normalizeEffort(value: unknown): Effort | undefined {
  return typeof value === "string" && (VALID_EFFORTS as readonly string[]).includes(value)
    ? (value as Effort)
    : undefined
}
