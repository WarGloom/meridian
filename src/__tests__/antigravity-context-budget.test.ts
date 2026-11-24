import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { blocks, parseAgRequest, type AgMessage } from "../proxy/backends/antigravityProtocol"
import { estimateAgTextTokens } from "../proxy/backends/antigravityTokens"
import { DEFAULT_PROXY_CONFIG } from "../proxy/types"

const executable = fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url))
const cleanup: (() => Promise<void>)[] = []
const saved = { ...process.env }
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop()
  for (const key of Object.keys(process.env)) if (key.startsWith("MERIDIAN_AGY_")) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})
const tools = [{ name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }]
const text = (content: string): AgMessage => ({ role: "user", content })
const assistant = (content: string): AgMessage => ({ role: "assistant", content })
const historicalPairs = (count: number, payload: string): AgMessage[] =>
  Array.from({ length: count }, (_, i): AgMessage[] => [
    { role: "assistant", content: [{ type: "tool_use", id: `tool_${i}`, name: "lookup", input: { key: String(i) } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `tool_${i}`, content: payload }] },
  ]).flat()
const unpack = (prompt: string): AgMessage[] => JSON.parse(prompt.split("Client conversation:\n").at(-1)!)
function expectPairs(messages: AgMessage[]) {
  const pending = new Set<string>()
  for (const message of messages) for (const block of blocks(message)) {
    if (block.type === "tool_use") pending.add(block.id)
    if (block.type === "tool_result") expect(pending.delete(block.tool_use_id)).toBe(true)
  }
  expect(pending.size).toBe(0)
}

async function fixture(priming?: string, persist = false, inlineToolSchemas = true, allowNativeSubagents = false) {
  const directory = await mkdtemp(join(tmpdir(), "agy-context-budget-"))
  const path = join(directory, "steps.jsonl")
  const runtime = new AntigravityRuntime({ executable, allowToolBridge: true, turnTimeoutMs: 5000, inlineToolSchemas, allowNativeSubagents, statePath: persist ? join(directory, "state.sqlite") : undefined })
  runtime.childEnv.AGY_FIXTURE_CONTEXT_LOG = path
  if (priming) runtime.childEnv.AGY_FIXTURE_CONTEXT_PRIMING = priming
  const backend = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
  cleanup.push(backend.closeBackend, () => rm(directory, { recursive: true, force: true }))
  const send = (messages: AgMessage[], overrides: object = {}) => backend.app.fetch(new Request("http://local/v1/messages", {
    method: "POST", body: JSON.stringify({ model: "fixture-model", tools, max_tokens: 128, messages, ...overrides }),
  }))
  const steps = async (): Promise<{ pid: number; prompt: string }[]> =>
    (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line))
  return { send, steps, runtime }
}

describe("Antigravity context budgeting", () => {
  it("submits large catalog-backed inputs on cold and warm turns", async () => {
    const { send, steps } = await fixture(undefined, false, false)
    const overrides = { system: "s".repeat(151_000), tools: [{ name: "lookup", input_schema: { type: "object", properties: { key: { type: "string", description: "d".repeat(76_000) } } } }] }
    const first = [text("SKIP_TOOLS first")]
    const response = await send(first, overrides)
    expect(response.status).toBe(200)
    const answer = await response.json() as { content: { text: string }[] }
    const next = await send([...first, assistant(answer.content[0]!.text), text("SKIP_TOOLS second")], overrides)
    expect(next.status).toBe(200)
    const frames = await steps()
    expect(frames).toHaveLength(2)
    expect(frames[1]!.pid).toBe(frames[0]!.pid)
    for (const frame of frames) {
      expect(Buffer.byteLength(frame.prompt)).toBeLessThanOrEqual(190_000)
      expect(frame.prompt).not.toContain("d".repeat(100))
      expect(frame.prompt).toContain('"lookup"')
    }
  })
  it("defaults to one bounded cold input with the newest request and intact tool pairs", async () => {
    const { send, steps } = await fixture()
    const result = await send([text("EARLIEST"), ...historicalPairs(48, "\u6f22".repeat(1700)), assistant("Done"), text("SKIP_TOOLS CURRENT_TAIL")])
    expect(result.status).toBe(200)
    const prompts = await steps()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.prompt).toContain("CURRENT_TAIL")
    expect(prompts[0]!.prompt).toContain("omitted")
    expect(Buffer.byteLength(prompts[0]!.prompt)).toBeLessThanOrEqual(190000)
    expect(estimateAgTextTokens(prompts[0]!.prompt)).toBeLessThanOrEqual(52000)
    expectPairs(unpack(prompts[0]!.prompt))
  })

  it("keeps the user's goal when a long run of short tool pairs has no newer typed request", async () => {
    process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = "5000"
    const { send, steps } = await fixture()
    const result = await send([text("ORIGINAL_GOAL"), ...historicalPairs(64, "short result")])
    expect(result.status).toBe(200)
    const frames = await steps()
    const messages = unpack(frames[0]!.prompt)
    expect(frames).toHaveLength(1)
    expect(Buffer.byteLength(frames[0]!.prompt)).toBeLessThanOrEqual(5000)
    expect(frames[0]!.prompt).toContain("ORIGINAL_GOAL")
    expect(frames[0]!.prompt).toContain("tool_63")
    expect(frames[0]!.prompt).not.toContain("tool_0")
    expectPairs(messages)
  })

  it("restarts at the estimated warm context cap, then resumes with only new input", async () => {
    process.env.MERIDIAN_AGY_MAX_CONTEXT_TOKENS = "16000"
    const { send, steps } = await fixture()
    const messages: AgMessage[] = []
    for (let i = 0; i < 7; i++) {
      messages.push(text(i === 6 ? "SKIP_TOOLS tiny continuation" : `SKIP_TOOLS turn-${i} ` + "a".repeat(10000)))
      const response = await send(messages)
      expect(response.status).toBe(200)
      const answer = await response.json() as { content: { text: string }[] }
      messages.push(assistant(answer.content[0]!.text))
    }
    const frames = await steps()
    expect(frames).toHaveLength(7)
    expect(frames[0]!.pid).toBe(frames[1]!.pid)
    expect(unpack(frames[1]!.prompt)).toHaveLength(1)
    expect(frames[5]!.pid).not.toBe(frames[0]!.pid)
    expect(frames[6]!.pid).toBe(frames[5]!.pid)
    expect(unpack(frames[6]!.prompt)).toEqual([{ role: "user", content: [{ type: "text", text: "SKIP_TOOLS tiny continuation" }] }])
  })

  it("only loads cold history in multiple steps when explicitly enabled", async () => {
    process.env.MERIDIAN_AGY_CHUNKED_HISTORY = "1"
    const { send, steps, runtime } = await fixture()
    const result = await send([text("EARLIEST"), ...historicalPairs(12, "x".repeat(24000)), assistant("Done"), text("SKIP_TOOLS CURRENT_TAIL")])
    expect(result.status).toBe(200)
    const reply = await result.json() as { content: { type: string; text: string }[]; usage: { input_tokens: number } }
    expect(reply.content).toEqual([{ type: "text", text: "READY" }])
    expect(reply.usage.input_tokens).toBe(120)
    const frames = await steps()
    expect(frames.length).toBeGreaterThan(1)
    expect(new Set(frames.map(frame => frame.pid)).size).toBe(1)
    for (const frame of frames.slice(0, -1)) {
      expect(frame.prompt).toStartWith("History loading step.")
      expect(Buffer.byteLength(frame.prompt)).toBeLessThanOrEqual(180000)
      expectPairs(unpack(frame.prompt))
    }
    expect(frames.at(-1)!.prompt).toContain("CURRENT_TAIL")
    expect(runtime.requests[0]!.inputTokens).toBe(120 + 100 * (frames.length - 1))
  })

  it("carries the current goal and the latest tool batch into the final input", async () => {
    process.env.MERIDIAN_AGY_CHUNKED_HISTORY = "1"
    const { send, steps } = await fixture("silent")
    const result = await send([text("CURRENT_GOAL"), ...historicalPairs(12, "x".repeat(24000))])
    expect(result.status).toBe(200)
    const frames = await steps()
    expect(frames.length).toBeGreaterThan(1)
    expect(frames.slice(0, -1).every(frame => !frame.prompt.includes("CURRENT_GOAL"))).toBe(true)
    const final = unpack(frames.at(-1)!.prompt)
    expect(final[0]).toEqual({ role: "user", content: [{ type: "text", text: "CURRENT_GOAL" }] })
    expect(frames.at(-1)!.prompt).toContain("tool_11")
    expectPairs(final)
  })

  for (const mode of ["rpc", "tool-frame", "no-marker"] as const) {
    it(`enforces the priming boundary for ${mode}`, async () => {
      process.env.MERIDIAN_AGY_CHUNKED_HISTORY = "1"
      const { send, steps } = await fixture(mode)
      const result = await send([text("EARLIEST"), ...historicalPairs(12, "x".repeat(24000)), text("SKIP_TOOLS CURRENT_TAIL")])
      if (mode === "rpc") {
        expect(result.status).toBe(200)
        const reply = await result.json() as { content: { type: string; text: string }[] }
        expect(reply.content).toEqual([{ type: "text", text: "READY" }])
      } else {
        expect(result.status).toBe(502)
        expect(await steps()).toHaveLength(1)
      }
    })
  }

  it("rejects a dense warm input that fits the byte guard but exceeds the step estimate", async () => {
    const { send, steps } = await fixture()
    expect((await send([text("SKIP_TOOLS first")])).status).toBe(200)
    const result = await send([text("SKIP_TOOLS first"), assistant("READY"), text("\u6f22".repeat(20000))])
    expect(result.status).toBe(400)
    expect(await steps()).toHaveLength(1)
  })

  it.each([false, true])("fits an over-budget pending batch without losing correlation (native grant: %s)", async native => {
    const { send, steps, runtime } = await fixture(undefined, false, true, native)
    const messages = [text("PARALLEL2 Run lookup")]
    const first = await send(messages)
    expect(first.status).toBe(200)
    const reply = await first.json() as { content: Extract<ReturnType<typeof blocks>[number], { type: "tool_use" }>[] }
    const calls = reply.content.filter(block => block.type === "tool_use")
    expect(calls.map(call => call.name)).toEqual(["lookup", "lookup"])
    const large = "HEAD!" + "😀".repeat(80000) + "!TAIL"
    const result = await send([...messages, { role: "assistant", content: reply.content }, {
      role: "user", content: calls.map((call, index) => ({ type: "tool_result", tool_use_id: call.id, content: index === 0 ? large : "SMALL_RESULT" })),
    }])
    expect(result.status).toBe(200)
    const answer = (await result.json() as { content: { text: string }[] }).content.map(block => block.text).join("")
    const marker = /\n\[Meridian: Tool result "lookup" \(call "([^"\n]+)"\), (\d+) original bytes, (\d+) bytes omitted\.[^\n]+\]\n/.exec(answer)
    expect(marker?.[1]).toBe(calls[0]?.id)
    expect(Number(marker?.[2])).toBe(Buffer.byteLength(large))
    expect(answer.match(/bytes omitted/g)).toHaveLength(1)
    const [head, tail] = answer.split(marker?.[0] ?? "INVALID_MARKER")
    expect(head).toMatch(/^HEAD!😀+/u)
    expect(tail).toMatch(/😀+!TAIL[|]SMALL_RESULT$/u)
    expect(Number(marker?.[3])).toBe(Buffer.byteLength(large) - Buffer.byteLength((head ?? "") + (tail ?? "").replace(/\|SMALL_RESULT$/, "")))
    expect(answer.isWellFormed()).toBe(true)
    expect(await steps()).toHaveLength(native ? 1 : 2)
    expect(runtime.requests[0]?.continuation).toBe(native ? "tool-result" : "history-replay")
  })

  it("rejects the newest oversized message but fits it as historical input on the next request", async () => {
    process.env.MERIDIAN_AGY_CHUNKED_HISTORY = "1"
    const { send, steps } = await fixture("silent")
    const first = text("SKIP_TOOLS first")
    expect((await send([first])).status).toBe(200)
    const history = [first, assistant("READY")]
    const rejected = text("HISTORY_HEAD" + "z".repeat(320_000) + "HISTORY_TAIL")
    const result = await send([...history, rejected])
    expect(result.status).toBe(400)
    expect(await result.json()).toMatchObject({ error: { type: "invalid_request_error", message: expect.stringMatching(/Shorten.*file.*reference/) } })
    expect(await steps()).toHaveLength(1)
    expect((await send([...history, rejected, text("SKIP_TOOLS normal")])).status).toBe(200)
    const frames = await steps()
    expect(frames.at(-1)?.prompt).toContain("SKIP_TOOLS normal")
    const wire = frames.slice(1).map(frame => frame.prompt).join("\n")
    expect(wire).toMatch(/HISTORY_HEAD[\s\S]*bytes omitted[\s\S]*HISTORY_TAIL/)
    expect(frames.every(frame => Buffer.byteLength(frame.prompt) <= 180_000)).toBe(true)
  })

  it("fits oversized historical and newest tool pairs during cold replay without losing their ids", async () => {
    process.env.MERIDIAN_AGY_CHUNKED_HISTORY = "1"
    const { send, steps } = await fixture("silent")
    const payload = "RESULT_HEAD" + "x".repeat(320_000) + "RESULT_TAIL"
    const result = await send([text("Read both chunks"), ...historicalPairs(2, payload)])
    expect(result.status).toBe(200)
    const frames = await steps()
    expect(frames.every(frame => Buffer.byteLength(frame.prompt) <= 180_000)).toBe(true)
    const replay = frames.flatMap(frame => unpack(frame.prompt))
    expectPairs(replay)
    const results = replay.flatMap(blocks).filter(block => block.type === "tool_result")
    expect(results.map(block => block.tool_use_id)).toEqual(["tool_0", "tool_1"])
    for (const result of results) expect(result.content).toMatch(/^RESULT_HEAD[\s\S]*320022 original bytes, \d+ bytes omitted[\s\S]*RESULT_TAIL$/)
  })

  it("rejects an impossible output reserve and accepts a later request with a smaller reserve", async () => {
    process.env.MERIDIAN_AGY_MAX_CONTEXT_TOKENS = "3000"
    const { send, steps } = await fixture()
    const first = text("SKIP_TOOLS first")
    expect((await send([first])).status).toBe(200)
    const history = [first, assistant("READY"), text("SKIP_TOOLS continue")]
    const response = await send(history, { max_tokens: 3000 })
    expect(response.status).toBe(400)
    expect(await resultMessage(response)).toContain("reduce requested output")
    expect((await send(history)).status).toBe(200)
    expect(await steps()).toHaveLength(2)
  })

  it("applies the step budget before starting a restored CLI process", async () => {
    const { send, steps, runtime } = await fixture(undefined, true)
    const history = [text("SKIP_TOOLS completed"), assistant("READY")]
    const native = runtime.nativeSessions!
    const workspace = await mkdtemp(join(native.directory, "conversation-"))
    native.save(parseAgRequest({ model: "fixture-model", tools, max_tokens: 128, messages: [...history, text("Next")] }), history, {
      conversationId: "11111111-1111-4111-8111-111111111111", workspace, count: history.length,
    })
    const response = await send([...history, text("\u6f22".repeat(20000))])
    expect(response.status).toBe(400)
    expect(runtime.restored).toBe(1)
    expect(await resultMessage(response)).toContain("estimated")
    await expect(steps()).rejects.toThrow("ENOENT")
  })
})

async function resultMessage(response: Response): Promise<string> {
  return (await response.json() as { error: { message: string } }).error.message
}
