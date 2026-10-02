import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { fetchOAuthUsageResult, resetOAuthUsageCache } from "../proxy/oauthUsage"
import type { CredentialStore, CredentialsFile } from "../proxy/tokenRefresh"

const usage = { seven_day: { utilization: 12, resets_at: null } }
const tokenUrl = "https://platform.claude.com/v1/oauth/token"

describe("OAuth usage 401 recovery", () => {
  let credentials: CredentialsFile
  let store: CredentialStore
  let tokens: string[]
  let readonlyBefore: string | undefined
  let network: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
  let warnings: ReturnType<typeof spyOn<typeof console, "warn">>

  beforeEach(() => {
    resetOAuthUsageCache()
    readonlyBefore = process.env.MERIDIAN_CREDENTIALS_READONLY
    process.env.MERIDIAN_CREDENTIALS_READONLY = ""
    credentials = { claudeAiOauth: {
      accessToken: "old-access", refreshToken: "fake-refresh",
      expiresAt: Date.now() + 3600_000,
      subscriptionType: "max", rateLimitTier: "default_claude_max_5x",
    } }
    store = {
      async read() { return structuredClone(credentials) },
      async write(next) { credentials = structuredClone(next); return true },
    }
    tokens = []
    warnings = spyOn(console, "warn").mockImplementation(() => {})
    // Every refresh/plan request is intercepted; stores are entirely in memory.
    network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
      throw new Error("unexpected network request")
    }, { preconnect: () => undefined }))
  })

  afterEach(() => {
    network.mockRestore()
    warnings.mockRestore()
    if (readonlyBefore === undefined) delete process.env.MERIDIAN_CREDENTIALS_READONLY
    else process.env.MERIDIAN_CREDENTIALS_READONLY = readonlyBefore
    resetOAuthUsageCache()
  })

  async function usageFetch(url: string, init?: RequestInit): Promise<Response> {
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage")
    const headers = new Headers(init?.headers)
    expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20")
    expect(headers.get("Accept")).toBe("application/json")
    tokens.push(headers.get("Authorization") ?? "")
    return tokens.length === 1
      ? new Response("unauthorized", { status: 401 })
      : Response.json(usage)
  }

  test("refreshes once and retries with the persisted access token after 401", async () => {
    // Given a rejected access token and a successful refresh exchange.
    network.mockImplementation(Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(tokenUrl)
      expect(init?.method).toBe("POST")
      expect(JSON.parse(String(init?.body))).toMatchObject({
        grant_type: "refresh_token", refresh_token: "fake-refresh",
      })
      return Response.json({ access_token: "new-access", refresh_token: "rotated-refresh", expires_in: 3600 })
    }, { preconnect: () => undefined }))
    // When usage rejects the old token.
    const result = await fetchOAuthUsageResult({ store, fetchImpl: usageFetch, profileId: "selected-profile" })
    // Then the same store supplies the one retry, without a warning.
    expect(result.snapshot?.windows).toEqual([{ type: "seven_day", utilization: 0.12, resetsAt: null }])
    expect(tokens).toEqual(["Bearer old-access", "Bearer new-access"])
    expect(network).toHaveBeenCalledTimes(1)
    expect(credentials.claudeAiOauth.refreshToken).toBe("rotated-refresh")
    expect(warnings).not.toHaveBeenCalled()
  })

  test("logs a second 401 once and stops after one refresh and one retry", async () => {
    // Given a refresh that succeeds but an endpoint that rejects both tokens.
    network.mockImplementation(Object.assign(
      async () => Response.json({ access_token: "new-access", expires_in: 3600 }),
      { preconnect: () => undefined },
    ))
    const fetchImpl = async (url: string, init?: RequestInit) => {
      await usageFetch(url, init)
      return new Response("unauthorized", { status: 401 })
    }
    // When the refreshed token is also rejected.
    const result = await fetchOAuthUsageResult({ store, fetchImpl })
    // Then there is no retry loop or duplicate unavailable diagnostic.
    expect(result.snapshot).toBeNull()
    expect(result.error).toBe("upstream_error")
    expect(tokens).toEqual(["Bearer old-access", "Bearer new-access"])
    expect(network).toHaveBeenCalledTimes(1)
    expect(warnings.mock.calls).toEqual([
      ['[PROXY] oauth_usage.unavailable {"reason":"http_error","httpStatus":401}'],
    ])
  })

  test("reuses an SDK rotation without refreshing, including in read-only mode", async () => {
    // Given the credential owner rotates while the first request is in flight.
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const response = await usageFetch(url, init)
      credentials.claudeAiOauth.accessToken = "owner-access"
      return response
    }
    // When that request gets a 401 for the old token.
    const result = await fetchOAuthUsageResult({ store, fetchImpl })
    // Then the retry uses the owner's token, with no refresh or credential write.
    expect(result.snapshot?.windows[0]?.utilization).toBe(0.12)
    expect(tokens).toEqual(["Bearer old-access", "Bearer owner-access"])
    expect(network).not.toHaveBeenCalled()
    expect(warnings).not.toHaveBeenCalled()
  })

  test("rereads a concurrent owner rotation after its own refresh fails", async () => {
    // Given the owner's successful rotation races with this failed exchange.
    network.mockImplementation(Object.assign(async () => {
      credentials.claudeAiOauth.accessToken = "owner-access"
      return new Response("refresh failed", { status: 400 })
    }, { preconnect: () => undefined }))
    // When the refresh fails after the usage 401.
    const result = await fetchOAuthUsageResult({ store, fetchImpl: usageFetch })
    // Then failure does not discard the fresh stored token or add retries.
    expect(result.snapshot?.windows[0]?.utilization).toBe(0.12)
    expect(tokens).toEqual(["Bearer old-access", "Bearer owner-access"])
    expect(network).toHaveBeenCalledTimes(1)
    expect(warnings).not.toHaveBeenCalled()
  })
})
