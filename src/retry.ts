/**
 * Decide whether an HTTP status code is worth retrying. Retryable: 408
 * (Request Timeout), 429 (Rate Limited), 502/503/504 (transient server
 * issues). Everything else — including 4xx that we shouldn't replay —
 * fails immediately.
 */
export function shouldRetry(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Exponential backoff with jitter. Attempt 0 → ~200ms, 1 → ~500ms,
 * 2 → ~1000ms, 3 → ~2000ms, capped at ~5000ms. Jitter prevents
 * thundering-herd retries when many clients see the same blip.
 */
export function backoffMs(attempt: number): number {
  const base = Math.min(5000, 200 * Math.pow(2.5, attempt));
  const jitter = base * 0.3 * Math.random();
  return Math.round(base + jitter);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * RFC 9110: if the server includes a `Retry-After` header (either a
 * delta-seconds integer or an HTTP-date), honor that instead of our
 * computed backoff — within reason (cap at 60s).
 */
export function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const asNumber = Number(header);
  if (Number.isFinite(asNumber)) return Math.min(60_000, Math.max(0, asNumber * 1000));
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) return Math.min(60_000, Math.max(0, asDate - Date.now()));
  return null;
}
