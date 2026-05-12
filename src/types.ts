/** 0x-prefixed lowercase SHA-256, exactly 66 chars long. */
export type ContentHash = string;

export interface StampInput {
  /** SHA-256 of the file contents, 0x-prefixed lowercase. Get one with `hashFile()`. */
  contentHash: ContentHash;
  /** Original filename, stored as ownership metadata only. */
  fileName?: string;
  /** File size in bytes, metadata only. */
  fileSize?: number;
  /** MIME type, metadata only (e.g. `application/pdf`). */
  mimeType?: string;
  /** ISO 3166-1 alpha-2 (e.g. `IT`) — drives the legal framing on the certificate. */
  jurisdiction?: string;
  /** BCP-47 locale for the certificate (e.g. `it`, `en-US`). */
  locale?: string;
}

export interface StampResult {
  ownershipId: string;
  stampId: string;
  contentHash: ContentHash;
  fileName: string | null;
  /** True when this caller already owned the same hash — no credit was charged. */
  duplicate: boolean;
}

export interface CreateStampResponse {
  stamp: StampResult;
  creditsCharged: number;
}

export interface BatchInput {
  items: StampInput[];
  /** Default jurisdiction applied to every item without its own. */
  jurisdiction?: string;
  /** Default locale stored on each ownership row. */
  locale?: string;
}

export interface CreateBatchResponse {
  results: StampResult[];
  creditsCharged: number;
  duplicateCount: number;
}

export type StampStatus = "pending" | "anchored";

export interface BitcoinAnchor {
  status: "pending" | "confirmed";
  blockHeight: number | null;
  blockTime: string | null;
}

export interface PolygonAnchor {
  chain: "polygon" | "polygon-amoy";
  merkleRoot: string;
  txHash: string;
  blockNumber: number;
  blockTime: string;
  bitcoin: BitcoinAnchor;
}

export interface Stamp {
  contentHash: ContentHash;
  status: StampStatus;
  createdAt: string;
  merkleProof: string[] | null;
  anchor: PolygonAnchor | null;
}

export interface Account {
  id: string;
  email: string | null;
  credits: number;
}

export interface CertificateOptions {
  /** Locale of the certificate PDF (overrides stamp's stored locale). */
  locale?: string;
  /** Jurisdiction code for the legal framing block (overrides stamp's stored jurisdiction). */
  jurisdiction?: string;
}

export interface RequestOptions {
  /** Override the auto-generated Idempotency-Key for write operations. */
  idempotencyKey?: string;
  /** AbortSignal — call `controller.abort()` to cancel. */
  signal?: AbortSignal;
}

export interface ClientOptions {
  /** `ba_live_<32 hex chars>` from https://bastamp.com/account/api-keys */
  apiKey: string;
  /** Override the API root. Default: `https://bastamp.com`. */
  baseUrl?: string;
  /** Default fetch retry count on 429/5xx + network errors. Default: 3. */
  maxRetries?: number;
  /** Provide a custom fetch (e.g. for testing or non-browser/Node runtimes). */
  fetch?: typeof globalThis.fetch;
}

export interface ApiErrorBody {
  error: {
    type: string;
    message: string;
  };
}
