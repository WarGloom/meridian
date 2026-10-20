/**
 * Tests for session store pruning.
 *
 * The file store is bounded by count and by idle age: the least recently used
 * entries go first when capacity is exceeded, and mappings idle past the age
 * limit are dropped on the next publish.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn, type Mock } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { storeSharedSession, lookupSharedSession, clearSharedSessions, setSessionStoreDir } from "../proxy/sessionStore"
import { setupStoreBackend, teardownStoreBackend } from "./fixtures/bookkeeping-store-backend"

describe("Session store count-based pruning", () => {
  let tmpDir: string
  let dateSpy: Mock<typeof Date.now>
  const originalDir = process.env.CLAUDE_PROXY_SESSION_DIR
  const originalMax = process.env.CLAUDE_PROXY_MAX_STORED_SESSIONS
  const originalAge = process.env.MERIDIAN_MAX_STORED_SESSION_AGE_DAYS

  beforeEach(async () => {
    // Mock Date.now() to return increasing values so that
    // lastUsedAt ordering is deterministic even when the loop runs in <1ms
    // (which happens on fast CI runners).
    let now = 1_000_000
    dateSpy = spyOn(Date, "now").mockImplementation(() => now++)
    tmpDir = mkdtempSync(join(tmpdir(), "session-pruning-test-"))
    setSessionStoreDir(tmpDir)
    setupStoreBackend(tmpDir)
    process.env.CLAUDE_PROXY_MAX_STORED_SESSIONS = "5"
    await clearSharedSessions()
  })

  afterEach(() => {
    teardownStoreBackend()
    dateSpy.mockRestore()
    setSessionStoreDir(null)
    rmSync(tmpDir, { recursive: true, force: true })
    if (originalDir === undefined) delete process.env.CLAUDE_PROXY_SESSION_DIR
    else process.env.CLAUDE_PROXY_SESSION_DIR = originalDir
    if (originalMax === undefined) delete process.env.CLAUDE_PROXY_MAX_STORED_SESSIONS
    else process.env.CLAUDE_PROXY_MAX_STORED_SESSIONS = originalMax
    if (originalAge === undefined) delete process.env.MERIDIAN_MAX_STORED_SESSION_AGE_DAYS
    else process.env.MERIDIAN_MAX_STORED_SESSION_AGE_DAYS = originalAge
  })

  it("keeps all entries when under capacity", async () => {
    await storeSharedSession("a", "claude-a")
    await storeSharedSession("b", "claude-b")
    await storeSharedSession("c", "claude-c")

    expect(lookupSharedSession("a")?.claudeSessionId).toBe("claude-a")
    expect(lookupSharedSession("b")?.claudeSessionId).toBe("claude-b")
    expect(lookupSharedSession("c")?.claudeSessionId).toBe("claude-c")
  })

  it("prunes oldest entries when capacity is exceeded", async () => {
    // Fill to capacity
    for (let i = 0; i < 5; i++) {
      await storeSharedSession(`sess-${i}`, `claude-${i}`, i)
    }

    // All 5 should exist
    for (let i = 0; i < 5; i++) {
      expect(lookupSharedSession(`sess-${i}`)).toBeDefined()
    }

    // Add 2 more — should evict the 2 oldest (sess-0, sess-1)
    await storeSharedSession("sess-5", "claude-5", 5)
    await storeSharedSession("sess-6", "claude-6", 6)

    expect(lookupSharedSession("sess-0")).toBeUndefined()
    expect(lookupSharedSession("sess-1")).toBeUndefined()
    expect(lookupSharedSession("sess-2")).toBeDefined()
    expect(lookupSharedSession("sess-5")).toBeDefined()
    expect(lookupSharedSession("sess-6")).toBeDefined()
  })

  it("never prunes the mapping being published when the wall clock moves backward", async () => {
    for (let i = 0; i < 5; i++) {
      await storeSharedSession(`future-${i}`, `claude-future-${i}`)
    }
    dateSpy.mockImplementation(() => 1)

    expect(await storeSharedSession("new-after-clock-step", "claude-new")).not.toBe(false)
    expect(lookupSharedSession("new-after-clock-step")?.claudeSessionId).toBe("claude-new")
    expect(lookupSharedSession("future-0")).toBeUndefined()
  })

  it("prunes mappings idle longer than the age limit on the next publish", async () => {
    const day = 24 * 60 * 60 * 1000
    let now = 1_800_000_000_000
    dateSpy.mockImplementation(() => now)
    await storeSharedSession("stale", "claude-stale")
    now += 6 * day
    await storeSharedSession("recent", "claude-recent")

    // stale is now 8 days idle (default limit 7), recent only 2
    now += 2 * day
    await storeSharedSession("fresh", "claude-fresh")

    expect(lookupSharedSession("stale")).toBeUndefined()
    expect(lookupSharedSession("recent")?.claudeSessionId).toBe("claude-recent")
    expect(lookupSharedSession("fresh")?.claudeSessionId).toBe("claude-fresh")
  })

  it("keeps idle mappings when the age limit is 0", async () => {
    process.env.MERIDIAN_MAX_STORED_SESSION_AGE_DAYS = "0"
    let now = 1_800_000_000_000
    dateSpy.mockImplementation(() => now)
    await storeSharedSession("ancient", "claude-ancient")
    now += 60 * 24 * 60 * 60 * 1000
    await storeSharedSession("fresh", "claude-fresh")

    expect(lookupSharedSession("ancient")?.claudeSessionId).toBe("claude-ancient")
  })

  it("preserves most recently used entries during pruning", async () => {
    // Store 5 sessions
    for (let i = 0; i < 5; i++) {
      await storeSharedSession(`sess-${i}`, `claude-${i}`, i)
    }

    // "Touch" sess-0 by re-storing it (updates lastUsedAt)
    await storeSharedSession("sess-0", "claude-0-updated", 0)

    // Add a new one — should evict sess-1 (oldest untouched), NOT sess-0
    await storeSharedSession("sess-new", "claude-new")

    expect(lookupSharedSession("sess-0")?.claudeSessionId).toBe("claude-0-updated")
    expect(lookupSharedSession("sess-1")).toBeUndefined()
    expect(lookupSharedSession("sess-new")).toBeDefined()
  })
})
