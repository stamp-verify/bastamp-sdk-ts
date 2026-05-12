import { describe, expect, it } from "vitest";
import { backoffMs, retryAfterMs, shouldRetry, sleep } from "../src/retry.js";

describe("shouldRetry", () => {
  it("retries on transient HTTP statuses", () => {
    for (const status of [408, 429, 502, 503, 504]) {
      expect(shouldRetry(status), `status ${status}`).toBe(true);
    }
  });

  it("does NOT retry on deterministic 4xx or success codes", () => {
    for (const status of [200, 201, 204, 301, 400, 401, 402, 403, 404, 409]) {
      expect(shouldRetry(status), `status ${status}`).toBe(false);
    }
  });

  it("does NOT retry on 500 (server-side bug — replay would just hit it again)", () => {
    expect(shouldRetry(500)).toBe(false);
  });
});

describe("backoffMs", () => {
  it("starts around 200 ms", () => {
    const v = backoffMs(0);
    expect(v).toBeGreaterThanOrEqual(200);
    expect(v).toBeLessThan(400);
  });

  it("grows roughly exponentially", () => {
    const a = backoffMs(0);
    const b = backoffMs(2);
    expect(b).toBeGreaterThan(a * 3);
  });

  it("is capped at 5000 ms + jitter", () => {
    for (let attempt = 5; attempt < 20; attempt++) {
      const v = backoffMs(attempt);
      expect(v).toBeLessThanOrEqual(5000 * 1.31);
    }
  });
});

describe("retryAfterMs", () => {
  it("returns null when header is missing", () => {
    expect(retryAfterMs(null)).toBeNull();
  });

  it("parses delta-seconds", () => {
    expect(retryAfterMs("30")).toBe(30_000);
    expect(retryAfterMs("0")).toBe(0);
  });

  it("parses HTTP-date as future delta", () => {
    const futureDate = new Date(Date.now() + 5_000).toUTCString();
    const ms = retryAfterMs(futureDate);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(3_000);
    expect(ms!).toBeLessThan(10_000);
  });

  it("clamps past HTTP-dates to 0 (don't sleep into the past)", () => {
    const pastDate = new Date(Date.now() - 60_000).toUTCString();
    expect(retryAfterMs(pastDate)).toBe(0);
  });

  it("caps at 60 seconds (so a misbehaving server can't park us indefinitely)", () => {
    expect(retryAfterMs("3600")).toBe(60_000);
  });

  it("returns null for garbage", () => {
    expect(retryAfterMs("not a date or number")).toBeNull();
  });
});

describe("sleep", () => {
  it("resolves after roughly the requested time", async () => {
    const t0 = Date.now();
    await sleep(50);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(40); // tiny grace for timer skew
    expect(elapsed).toBeLessThan(200);
  });

  it("rejects with AbortError if the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(sleep(1000, ctrl.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects with AbortError if the signal aborts mid-sleep", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    await expect(sleep(1000, ctrl.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
