# @bastamp/sdk

Official TypeScript SDK for the [BA | Stamp](https://bastamp.com) REST API. Anchor SHA-256 hashes of arbitrary files on the Polygon blockchain (and Bitcoin via OpenTimestamps) from any Node.js, Bun, Deno, or browser runtime.

The bytes of the file you're stamping never leave your machine — only the SHA-256 hash is sent.

```ts
import { BAStamp, hashFile } from "@bastamp/sdk";
import { readFile } from "node:fs/promises";

const client = new BAStamp({ apiKey: process.env.BASTAMP_API_KEY! });

const bytes = await readFile("contract.pdf");
const { stamp, creditsCharged } = await client.stamps.create({
  contentHash: await hashFile(bytes),
  fileName: "contract.pdf",
  fileSize: bytes.length,
  mimeType: "application/pdf",
});

console.log(stamp.contentHash, creditsCharged);
```

## Install

```bash
npm install @bastamp/sdk
# or
pnpm add @bastamp/sdk
# or
yarn add @bastamp/sdk
```

Requires Node 20+ (uses `fetch`, `crypto.subtle`, and `crypto.randomUUID` from the platform). Works in modern browsers and Bun/Deno without changes.

## Auth

Create an API key at [bastamp.com/account/api-keys](https://bastamp.com/account/api-keys). The plain value is shown once — store it in a secret manager (Vercel/GitHub Actions/1Password). Format: `ba_live_<32 hex chars>`.

## Usage

### Create a stamp

```ts
const { stamp, creditsCharged } = await client.stamps.create({
  contentHash: "0x...",
  fileName: "contract.pdf",   // optional, metadata only
  fileSize: 184326,           // optional, bytes
  mimeType: "application/pdf",// optional
  jurisdiction: "IT",         // optional, drives certificate's legal framing
  locale: "it",               // optional, certificate language
});
// stamp.duplicate === true if this account already owned the hash → 0 credits charged
```

The SDK auto-generates an `Idempotency-Key` per call. To override (e.g. tie idempotency to a workflow run id):

```ts
await client.stamps.create({ contentHash }, { idempotencyKey: `gh-run-${runId}` });
```

### Batch up to 100 stamps in one call

```ts
const { results, creditsCharged, duplicateCount } = await client.stamps.createBatch({
  items: [
    { contentHash: "0x...", fileName: "a.pdf" },
    { contentHash: "0x...", fileName: "b.pdf" },
  ],
  jurisdiction: "IT",
  locale: "it",
});
```

### Look up a stamp

```ts
const s = await client.stamps.get("0x...");
// s.status: "pending" | "anchored"
// s.anchor: { chain, merkleRoot, txHash, blockNumber, blockTime, bitcoin } | null
```

### Download the certificate PDF

```ts
const pdf = await client.stamps.downloadCertificate("0x...", { locale: "it", jurisdiction: "IT" });
// pdf is a Uint8Array — write to disk:
await fs.writeFile("certificate.pdf", pdf);
```

Throws `BAStampConflictError` (`type === "not_anchored"`) if the stamp is still pending. Anchoring lands at the next 5-minute batch tick.

### Account info

```ts
const account = await client.account.get();
console.log(account.credits);
```

### Hash any byte source

```ts
import { hashFile } from "@bastamp/sdk";

await hashFile(uint8Array);   // 0x...
await hashFile(arrayBuffer);  // 0x...
await hashFile(blob);         // 0x... (browser File / Blob)
await hashFile(buffer);       // 0x... (Node Buffer)
```

All variants delegate to `crypto.subtle.digest("SHA-256", ...)` — the computation is local; no network call.

## Errors

```ts
import {
  BAStampNoCreditsError,
  BAStampUnauthorizedError,
  BAStampConflictError,
} from "@bastamp/sdk";

try {
  await client.stamps.create({ contentHash });
} catch (err) {
  if (err instanceof BAStampNoCreditsError) {
    // 402 — top up at bastamp.com/#pricing
  } else if (err instanceof BAStampUnauthorizedError) {
    // 401 — rotate the key
  } else if (err instanceof BAStampConflictError && err.type === "idempotency_conflict") {
    // 409 — Idempotency-Key reused with a different payload
  } else {
    throw err;
  }
}
```

Error class hierarchy:

| Status | Class | When |
|---|---|---|
| 400 | `BAStampInvalidRequestError` | Bad hash format, missing field, etc. |
| 401 | `BAStampUnauthorizedError` | Missing / wrong Bearer token |
| 402 | `BAStampNoCreditsError` | Account is out of credits |
| 404 | `BAStampNotFoundError` | Stamp doesn't exist |
| 409 | `BAStampConflictError` | Idempotency conflict, or certificate requested before anchor |
| 429 | `BAStampRateLimitedError` | Rate limited (SDK retries automatically; surfaced only if retries exhaust) |
| other | `BAStampError` | Base class — `.status`, `.type`, `.body` |

## Retries

The SDK retries on 408, 429, 502, 503, 504 and on network errors. Up to `maxRetries` attempts (default 3, configurable via `new BAStamp({ apiKey, maxRetries })`) with exponential backoff + jitter (~200 ms → 5 s capped). Honors `Retry-After` headers when present.

Non-retryable: 400, 401, 402, 404, 409. They fail immediately.

## Cancel a request

```ts
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 5_000);
await client.stamps.create({ contentHash }, { signal: ctrl.signal });
```

## Examples

See [examples/basic.ts](./examples/basic.ts) for a runnable end-to-end script (`tsx examples/basic.ts <file>`).

## Why an official SDK

The REST API is straightforward — anyone can call it with `fetch`. The SDK exists because:

- Type-safe request bodies and responses from the [OpenAPI spec](https://bastamp.com/openapi.yaml).
- Sensible defaults: retries, idempotency keys, error subclasses.
- One-line file hashing via `hashFile` that works across Node, browser, Bun, Deno.
- No dependencies — fewer supply-chain things to worry about.

For verifying stamps independently (without trusting bastamp.com), see the [open-source verifier](https://github.com/stamp-verify/stamp-verify).

## License

MIT — see [LICENSE](./LICENSE).
