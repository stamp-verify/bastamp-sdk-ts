import { describe, expect, it, vi } from "vitest";
import { BAStamp } from "../src/client.js";
import {
  BAStampError,
  BAStampInvalidRequestError,
  BAStampNoCreditsError,
  BAStampNotFoundError,
  BAStampUnauthorizedError,
} from "../src/errors.js";

interface FakeFetchCall {
  url: string;
  init: RequestInit;
}

/**
 * Build a fake fetch that returns the given responses in order. Each entry
 * is either a Response object, or an Error to reject with. Records every
 * call so tests can assert on URL, headers, body.
 */
function fakeFetch(responses: (Response | Error)[]): {
  fetch: typeof globalThis.fetch;
  calls: FakeFetchCall[];
} {
  const calls: FakeFetchCall[] = [];
  let i = 0;
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = responses[i++];
    if (r === undefined) throw new Error(`fakeFetch: no response defined for call ${i}`);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch: fetchImpl as unknown as typeof globalThis.fetch, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("BAStamp constructor", () => {
  it("throws when apiKey is missing", () => {
    // @ts-expect-error intentional
    expect(() => new BAStamp({})).toThrow(/apiKey/);
  });

  it("strips trailing slashes from baseUrl", async () => {
    const { fetch, calls } = fakeFetch([jsonResponse({ id: "x", email: null, credits: 0 })]);
    const c = new BAStamp({ apiKey: "ba_live_x", baseUrl: "https://example.com////", fetch });
    await c.account.get();
    expect(calls[0]!.url).toBe("https://example.com/api/v1/account");
  });
});

describe("stamps.create", () => {
  it("POSTs to /api/v1/stamps with Authorization, Content-Type, and auto Idempotency-Key", async () => {
    const { fetch, calls } = fakeFetch([
      jsonResponse(
        { stamp: { ownershipId: "o1", stampId: "s1", contentHash: "0xabc", fileName: "a.pdf", duplicate: false }, creditsCharged: 1 },
        201,
      ),
    ]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    const out = await c.stamps.create({ contentHash: "0xabc", fileName: "a.pdf" });

    const call = calls[0]!;
    expect(call.url).toBe("https://bastamp.com/api/v1/stamps");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ba_live_test");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.parse(call.init.body as string)).toEqual({ contentHash: "0xabc", fileName: "a.pdf" });
    expect(out.stamp.contentHash).toBe("0xabc");
    expect(out.creditsCharged).toBe(1);
  });

  it("uses the caller's idempotencyKey when provided", async () => {
    const { fetch, calls } = fakeFetch([
      jsonResponse({ stamp: { ownershipId: "o1", stampId: "s1", contentHash: "0xabc", fileName: null, duplicate: false }, creditsCharged: 1 }, 201),
    ]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    await c.stamps.create({ contentHash: "0xabc" }, { idempotencyKey: "gh-run-42" });
    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe("gh-run-42");
  });

  it("maps 402 to BAStampNoCreditsError", async () => {
    const { fetch } = fakeFetch([
      jsonResponse({ error: { type: "no_credits", message: "account has no remaining credits" } }, 402),
    ]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch, maxRetries: 0 });
    await expect(c.stamps.create({ contentHash: "0xabc" })).rejects.toBeInstanceOf(BAStampNoCreditsError);
  });

  it("maps 401 to BAStampUnauthorizedError", async () => {
    const { fetch } = fakeFetch([jsonResponse({ error: { type: "unauthorized", message: "bad key" } }, 401)]);
    const c = new BAStamp({ apiKey: "ba_live_bad", fetch, maxRetries: 0 });
    await expect(c.stamps.create({ contentHash: "0xabc" })).rejects.toBeInstanceOf(BAStampUnauthorizedError);
  });

  it("maps 400 to BAStampInvalidRequestError", async () => {
    const { fetch } = fakeFetch([jsonResponse({ error: { type: "invalid_request", message: "bad hash" } }, 400)]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch, maxRetries: 0 });
    await expect(c.stamps.create({ contentHash: "garbage" })).rejects.toBeInstanceOf(BAStampInvalidRequestError);
  });

  it("retries on 503 and ultimately succeeds", async () => {
    const success = jsonResponse(
      { stamp: { ownershipId: "o1", stampId: "s1", contentHash: "0xabc", fileName: null, duplicate: false }, creditsCharged: 1 },
      201,
    );
    const { fetch, calls } = fakeFetch([
      jsonResponse({ error: { type: "unavailable", message: "down" } }, 503),
      jsonResponse({ error: { type: "unavailable", message: "down" } }, 503),
      success,
    ]);
    // Skip real backoff sleeps to keep the test fast.
    vi.useFakeTimers();
    const c = new BAStamp({ apiKey: "ba_live_test", fetch, maxRetries: 3 });
    const promise = c.stamps.create({ contentHash: "0xabc" });
    // Drain all backoff timers.
    for (let i = 0; i < 3; i++) {
      await vi.runAllTimersAsync();
    }
    const out = await promise;
    vi.useRealTimers();
    expect(out.stamp.contentHash).toBe("0xabc");
    expect(calls).toHaveLength(3);
  });

  it("does NOT retry on 400 (deterministic failure)", async () => {
    const { fetch, calls } = fakeFetch([
      jsonResponse({ error: { type: "invalid_request", message: "bad hash" } }, 400),
    ]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch, maxRetries: 3 });
    await expect(c.stamps.create({ contentHash: "garbage" })).rejects.toBeInstanceOf(BAStampError);
    expect(calls).toHaveLength(1);
  });
});

describe("stamps.createBatch", () => {
  it("rejects empty arrays before hitting the network", async () => {
    const { fetch, calls } = fakeFetch([]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    await expect(c.stamps.createBatch({ items: [] })).rejects.toThrow(/non-empty/);
    expect(calls).toHaveLength(0);
  });

  it("rejects > 100 items before hitting the network", async () => {
    const { fetch, calls } = fakeFetch([]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    const items = Array.from({ length: 101 }, (_, i) => ({ contentHash: `0x${i.toString(16).padStart(64, "0")}` }));
    await expect(c.stamps.createBatch({ items })).rejects.toThrow(/100/);
    expect(calls).toHaveLength(0);
  });
});

describe("stamps.get", () => {
  it("GETs /api/v1/stamps/{hash} and parses the response", async () => {
    const { fetch, calls } = fakeFetch([
      jsonResponse({
        contentHash: "0xabc",
        status: "anchored",
        createdAt: "2026-05-12T10:00:00Z",
        merkleProof: ["0xdef"],
        anchor: null,
      }),
    ]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    const s = await c.stamps.get("0xabc");
    expect(calls[0]!.url).toBe("https://bastamp.com/api/v1/stamps/0xabc");
    expect(calls[0]!.init.method).toBe("GET");
    expect(s.status).toBe("anchored");
  });

  it("maps 404 to BAStampNotFoundError", async () => {
    const { fetch } = fakeFetch([jsonResponse({ error: { type: "not_found", message: "no stamp" } }, 404)]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch, maxRetries: 0 });
    await expect(c.stamps.get("0xdead")).rejects.toBeInstanceOf(BAStampNotFoundError);
  });
});

describe("stamps.downloadCertificate", () => {
  it("returns the raw PDF bytes and forwards locale + jurisdiction as query params", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    const { fetch, calls } = fakeFetch([
      new Response(pdfBytes, { status: 200, headers: { "Content-Type": "application/pdf" } }),
    ]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    const out = await c.stamps.downloadCertificate("0xabc", { locale: "it", jurisdiction: "IT" });
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(calls[0]!.url).toBe("https://bastamp.com/api/v1/stamps/0xabc/certificate?locale=it&jurisdiction=IT");
  });
});

describe("account.get", () => {
  it("returns { id, email, credits }", async () => {
    const { fetch } = fakeFetch([jsonResponse({ id: "u1", email: "u@example.com", credits: 42 })]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    const a = await c.account.get();
    expect(a).toEqual({ id: "u1", email: "u@example.com", credits: 42 });
  });
});
