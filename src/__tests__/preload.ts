/**
 * Test preload — runs before every test file.
 * Clears environment variables that would interfere with test isolation.
 */

import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Auth middleware reads this at request time; clear it so tests don't need API keys
delete process.env.MERIDIAN_API_KEY
delete process.env.MERIDIAN_DEFAULT_AGENT
delete process.env.MERIDIAN_PASSTHROUGH
delete process.env.MERIDIAN_WORKDIR
delete process.env.CLAUDE_PROXY_PASSTHROUGH
delete process.env.CLAUDE_PROXY_WORKDIR

// Point settings.ts at a throwaway directory so the suite never reads the
// developer's real ~/.config/meridian/settings.json. A live
// `routing: "priority"` setting made the sticky- and priority-routing
// integration tests fail locally while passing in CI, because both fall back
// to getSetting("routing") when MERIDIAN_ROUTING is unset — so those tests
// were asserting against whatever the developer happened to have configured.
// Keyed by pid so concurrent runs don't share state.
process.env.MERIDIAN_CONFIG_DIR = join(tmpdir(), `meridian-test-settings-${process.pid}`)
mkdirSync(process.env.MERIDIAN_CONFIG_DIR, { recursive: true })

// sdkFeatures.ts stores its independently configurable settings under
// XDG_CONFIG_HOME/meridian.  Isolate that path too: otherwise an explicit
// local adapter setting (for example opencode.thinking: "disabled") changes
// request-level SDK parameter tests.
process.env.XDG_CONFIG_HOME = join(tmpdir(), `meridian-test-sdk-features-${process.pid}`)
mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true })
