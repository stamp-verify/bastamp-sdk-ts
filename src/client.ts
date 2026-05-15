import {
  BAStampError,
  BAStampInvalidRequestError,
  BAStampUnauthorizedError,
  BAStampNoCreditsError,
  BAStampNotFoundError,
  BAStampConflictError,
  BAStampRateLimitedError,
} from "./errors.js";
import { backoffMs, retryAfterMs, shouldRetry, sleep } from "./retry.js";
import { AiProvenanceResource } from "./ai-provenance.js";
import { ProjectsResource } from "./projects.js";
import type {
  Account,
  ApiErrorBody,
  CertificateOptions,
  ClientOptions,
  CreateBatchResponse,
  CreateStampResponse,
  RequestOptions,
  Stamp,
  StampInput,
  BatchInput,
} from "./types.js";

const DEFAULT_BASE_URL = "https://bastamp.com";
const DEFAULT_MAX_RETRIES = 3;
const USER_AGENT = "bastamp-sdk-ts/0.4.0";

/**
 * BA | Stamp REST client.
 *
 * ```ts
 * import { BAStamp, hashFile } from "@bastamp/sdk";
 * const client = new BAStamp({ apiKey: process.env.BASTAMP_API_KEY! });
 *
 * const bytes = await fs.readFile("contract.pdf");
 * const { stamp } = await client.stamps.create({
 *   contentHash: await hashFile(bytes),
 *   fileName: "contract.pdf",
 *   fileSize: bytes.length,
 *   mimeType: "application/pdf",
 * });
 * console.log("anchored hash:", stamp.contentHash);
 * ```
 */
export class BAStamp {
  readonly stamps: StampsResource;
  readonly account: AccountResource;
  readonly aiProvenance: AiProvenanceResource;
  readonly projects: ProjectsResource;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #maxRetries: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(opts: ClientOptions) {
    if (!opts?.apiKey || typeof opts.apiKey !== "string") {
      throw new TypeError("BAStamp: `apiKey` is required");
    }
    this.#apiKey = opts.apiKey;
    this.#baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#maxRetries = Math.max(0, opts.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.stamps = new StampsResource(this);
    this.account = new AccountResource(this);
    this.aiProvenance = new AiProvenanceResource(this);
    this.projects = new ProjectsResource(this);
  }

  /** @internal */
  async _request<T>(
    method: "GET" | "POST",
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, string | undefined>;
      idempotencyKey?: string;
      signal?: AbortSignal;
      // When true, resolve to Response (for binary endpoints like certificate).
      raw?: boolean;
    } = {},
  ): Promise<T> {
    const url = new URL(this.#baseUrl + path);
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v != null) url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.#apiKey}`,
      "User-Agent": USER_AGENT,
      "Accept": options.raw ? "application/pdf, application/json" : "application/json",
    };
    let bodyString: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyString = JSON.stringify(options.body);
    }
    if (options.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }

    let attempt = 0;
    // The +1 reads naturally: maxRetries=3 means up to 4 attempts total.
    while (true) {
      let response: Response;
      try {
        response = await this.#fetch(url.toString(), {
          method,
          headers,
          body: bodyString,
          signal: options.signal,
        });
      } catch (err) {
        // Network-level error (DNS, TCP, abort). Retry transient kinds.
        if (attempt < this.#maxRetries && !(err instanceof DOMException && err.name === "AbortError")) {
          await sleep(backoffMs(attempt), options.signal);
          attempt++;
          continue;
        }
        throw err;
      }

      if (response.ok) {
        if (options.raw) return response as unknown as T;
        // 204 has no body
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }

      const shouldRetryThis = shouldRetry(response.status) && attempt < this.#maxRetries;
      if (shouldRetryThis) {
        const waitMs = retryAfterMs(response.headers.get("retry-after")) ?? backoffMs(attempt);
        await sleep(waitMs, options.signal);
        attempt++;
        continue;
      }

      throw await buildError(response);
    }
  }
}

class StampsResource {
  readonly #client: BAStamp;
  constructor(client: BAStamp) {
    this.#client = client;
  }

  /**
   * Anchor a single SHA-256 hash. Charges 1 credit; returns
   * `{ duplicate: true, ...}` with 0 charge if the caller already owns
   * this exact hash.
   */
  async create(input: StampInput, options: RequestOptions = {}): Promise<CreateStampResponse> {
    return this.#client._request("POST", "/api/v1/stamps", {
      body: input,
      idempotencyKey: options.idempotencyKey ?? randomIdempotencyKey(),
      signal: options.signal,
    });
  }

  /**
   * Anchor up to 100 hashes in one call. One credit per *new* item;
   * duplicates aren't charged but still appear in `results`.
   */
  async createBatch(input: BatchInput, options: RequestOptions = {}): Promise<CreateBatchResponse> {
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new TypeError("createBatch: `items` must be a non-empty array");
    }
    if (input.items.length > 100) {
      throw new TypeError(`createBatch: max 100 items per call (got ${input.items.length})`);
    }
    return this.#client._request("POST", "/api/v1/stamps/batch", {
      body: input,
      idempotencyKey: options.idempotencyKey ?? randomIdempotencyKey(),
      signal: options.signal,
    });
  }

  /**
   * Read a stamp's current status and on-chain anchor data. Returns
   * `status: "pending"` until the next batch tick (~5 minutes) anchors
   * it on Polygon.
   */
  async get(contentHash: string, options: RequestOptions = {}): Promise<Stamp> {
    return this.#client._request("GET", `/api/v1/stamps/${encodeURIComponent(contentHash)}`, {
      signal: options.signal,
    });
  }

  /**
   * Download the PDF certificate for a stamp as raw bytes. Throws 409
   * `not_anchored` if the stamp hasn't anchored on Polygon yet.
   */
  async downloadCertificate(
    contentHash: string,
    certOptions: CertificateOptions & RequestOptions = {},
  ): Promise<Uint8Array> {
    const response = await this.#client._request<Response>(
      "GET",
      `/api/v1/stamps/${encodeURIComponent(contentHash)}/certificate`,
      {
        query: { locale: certOptions.locale, jurisdiction: certOptions.jurisdiction },
        signal: certOptions.signal,
        raw: true,
      },
    );
    const buf = await response.arrayBuffer();
    return new Uint8Array(buf);
  }
}

class AccountResource {
  readonly #client: BAStamp;
  constructor(client: BAStamp) {
    this.#client = client;
  }

  /** Get the authenticated account's id, email, and remaining credits. */
  async get(options: RequestOptions = {}): Promise<Account> {
    return this.#client._request("GET", "/api/v1/account", { signal: options.signal });
  }
}

// ── helpers ──

async function buildError(response: Response): Promise<BAStampError> {
  const text = await response.text();
  let parsed: ApiErrorBody | undefined;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  const type = parsed?.error?.type ?? "unknown";
  const message = parsed?.error?.message ?? text ?? `HTTP ${response.status}`;
  const body: unknown = parsed ?? text;

  switch (response.status) {
    case 400: return new BAStampInvalidRequestError(message, body);
    case 401: return new BAStampUnauthorizedError(message, body);
    case 402: return new BAStampNoCreditsError(message, body);
    case 404: return new BAStampNotFoundError(message, body);
    case 409: return new BAStampConflictError(message, type, body);
    case 429: return new BAStampRateLimitedError(message, body);
    default:
      return new BAStampError(message, response.status, type, body);
  }
}

function randomIdempotencyKey(): string {
  // crypto.randomUUID is available on Node 20+, all modern browsers, Bun, Deno.
  return globalThis.crypto.randomUUID();
}
