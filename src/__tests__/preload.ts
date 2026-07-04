/**
 * Test preload — runs before every test file.
 * Clears environment variables that would interfere with test isolation.
 */

import { afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const testConfigHome = mkdtempSync(join(tmpdir(), "meridian-test-config-"))
process.env.XDG_CONFIG_HOME = testConfigHome

afterAll(() => {
  rmSync(testConfigHome, { recursive: true, force: true })
})

// Auth middleware reads this at request time; clear it so tests don't need API keys
delete process.env.MERIDIAN_API_KEY
delete process.env.MERIDIAN_DEFAULT_AGENT
delete process.env.MERIDIAN_PASSTHROUGH
delete process.env.MERIDIAN_WORKDIR
delete process.env.CLAUDE_PROXY_PASSTHROUGH
delete process.env.CLAUDE_PROXY_WORKDIR
