/**
 * Unit tests for effort normalization.
 *
 * The SDK `--effort` flag accepts a fixed vocabulary (low/medium/high/xhigh/max).
 * Clients (especially OpenAI-compatible ones) may send values outside it —
 * notably OpenAI's `"minimal"` — which the SDK rejects. normalizeEffort gates
 * the value so an unknown effort falls back to the model default (undefined)
 * instead of erroring the whole request.
 */
import { describe, it, expect } from "bun:test"
import { normalizeEffort, selectAgyClaudeModel, VALID_EFFORTS } from "../proxy/effort"

it("selects only the exact agy model and requested effort, defaulting to high", () => {
  const catalog = ["claude-sonnet-5-5-high", "claude-sonnet-5-5-low", "claude-opus-5-5-medium"]
  expect(selectAgyClaudeModel("claude-sonnet-5-5", undefined, catalog)).toBe("claude-sonnet-5-5-high")
  expect(selectAgyClaudeModel("claude-sonnet-5-5", "low", catalog)).toBe("claude-sonnet-5-5-low")
  expect(selectAgyClaudeModel("claude-opus-5-5", "medium", catalog)).toBe("claude-opus-5-5-medium")
  for (const [model, effort] of [["claude-sonnet-5-1", "high"], ["claude-sonnet-5-5[1m]", "high"],
    ["sonnet", "low"], ["claude-sonnet-5-5", "max"], ["claude-sonnet-5-5", ""],
    ["claude-sonnet-5-5", "medium"], ["claude-opus-5-5", undefined]] as const) {
    expect(selectAgyClaudeModel(model, effort, catalog)).toBeUndefined()
  }
})

describe("normalizeEffort", () => {
  it("passes through every valid Claude effort level", () => {
    for (const level of VALID_EFFORTS) {
      expect(normalizeEffort(level)).toBe(level)
    }
  })

  it("accepts xhigh and max (beyond the legacy low/medium/high)", () => {
    expect(normalizeEffort("xhigh")).toBe("xhigh")
    expect(normalizeEffort("max")).toBe("max")
  })

  it("drops OpenAI's 'minimal' (not a valid Claude effort)", () => {
    expect(normalizeEffort("minimal")).toBeUndefined()
  })

  it("drops unknown / malformed values rather than forwarding them", () => {
    expect(normalizeEffort("super")).toBeUndefined()
    expect(normalizeEffort("")).toBeUndefined()
    expect(normalizeEffort("HIGH")).toBeUndefined() // case-sensitive: SDK wants lowercase
    expect(normalizeEffort(undefined)).toBeUndefined()
    expect(normalizeEffort(null)).toBeUndefined()
    expect(normalizeEffort(3)).toBeUndefined()
    expect(normalizeEffort({})).toBeUndefined()
  })
})
