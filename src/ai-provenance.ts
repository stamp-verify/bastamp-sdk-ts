import type { BAStamp } from "./client.js";
import type { CreateStampResponse, RequestOptions } from "./types.js";
import { hashFile } from "./hash.js";

/**
 * Canonical manifest format BA | Stamp anchors for AI-generated content.
 * The fields below are committed to by the on-chain hash; preserving the
 * exact serialization (sorted keys, no whitespace) is the verifier's job.
 */
export interface AiProvenanceManifest {
  /** Schema id — pin this so downstream parsers can reject unknown shapes. */
  readonly schema: "bastamp.ai-provenance/v1";
  /** Model identifier (e.g. "gpt-5", "claude-opus-4-7", "stable-diffusion-xl"). */
  model: string;
  /** Optional model version / snapshot (e.g. "2026-04-15"). */
  modelVersion?: string;
  /** SHA-256 of the prompt, 0x-prefixed lowercase. */
  promptHash: string;
  /** SHA-256 of the output, 0x-prefixed lowercase. */
  outputHash: string;
  /** Generation timestamp, ISO 8601. Defaults to now if caller omits. */
  generatedAt: string;
  /** Optional generation parameters (temperature, seed, top_p, etc.). */
  params?: Record<string, unknown>;
  /** Caller-defined metadata (request id, user id hash, etc.). */
  metadata?: Record<string, unknown>;
}

type Hashable = string | Uint8Array | ArrayBuffer | Blob | Buffer;

export interface AttestInput {
  model: string;
  modelVersion?: string;
  /**
   * Either pass `prompt` (we hash it locally — bytes never leave your
   * machine) or `promptHash` (you've already hashed it; useful when the
   * prompt is private and you don't want it in memory longer than needed).
   * Pass exactly one of the two.
   */
  prompt?: Hashable;
  promptHash?: string;
  /** Same dual mode as `prompt` — either `output` or `outputHash`, not both. */
  output?: Hashable;
  outputHash?: string;
  generatedAt?: Date | string;
  params?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AttestResult {
  /** The manifest object — save this; it's needed to verify later. */
  manifest: AiProvenanceManifest;
  /** Canonical (sorted keys, no whitespace) JSON string — what was hashed. */
  manifestCanon: string;
  /** The anchored hash. Same as `stamp.stamp.contentHash`. */
  manifestHash: string;
  /** Underlying stamp result from /api/v1/stamps. */
  stamp: CreateStampResponse;
}

/**
 * AI-provenance helper. Builds a canonical attestation manifest for a
 * single AI generation event, hashes it locally, and anchors the hash on
 * the BA | Stamp pipeline — no new endpoint, no schema, just an opinionated
 * convention on top of /api/v1/stamps.
 *
 * The caller keeps the returned `manifest` (or `manifestCanon` string) and
 * delivers it alongside the AI output. A verifier later drops the manifest
 * on bastamp.com/verify/{hash}, the page recomputes the canonical SHA-256
 * and confirms it matches the on-chain anchor.
 */
export class AiProvenanceResource {
  readonly #client: BAStamp;
  constructor(client: BAStamp) {
    this.#client = client;
  }

  /**
   * Attest a single AI generation. Charges 1 credit on first submission
   * for a given manifest; identical re-submissions are deduped by the
   * underlying stamping flow (returns `duplicate: true`, no charge).
   *
   * ```ts
   * const r = await client.aiProvenance.attest({
   *   model: "gpt-5",
   *   modelVersion: "2026-04-15",
   *   prompt: "Summarize this email …",   // hashed locally
   *   output: completion.text,             // hashed locally
   *   params: { temperature: 0.7, seed: 42 },
   * });
   *
   * // save r.manifest with your output; r.stamp.stamp.contentHash is on chain.
   * await fs.writeFile("provenance.json", JSON.stringify(r.manifest, null, 2));
   * ```
   */
  async attest(input: AttestInput, options: RequestOptions = {}): Promise<AttestResult> {
    if (!input.model || typeof input.model !== "string") {
      throw new TypeError("attest: `model` is required (e.g. 'gpt-5')");
    }
    if ((input.prompt == null) === (input.promptHash == null)) {
      throw new TypeError("attest: provide exactly one of `prompt` or `promptHash`");
    }
    if ((input.output == null) === (input.outputHash == null)) {
      throw new TypeError("attest: provide exactly one of `output` or `outputHash`");
    }

    const promptHash = input.promptHash ?? (await hashFile(toBytes(input.prompt!)));
    const outputHash = input.outputHash ?? (await hashFile(toBytes(input.output!)));

    validateHash(promptHash, "promptHash");
    validateHash(outputHash, "outputHash");

    const generatedAt =
      typeof input.generatedAt === "string"
        ? input.generatedAt
        : (input.generatedAt ?? new Date()).toISOString();

    const manifest: AiProvenanceManifest = {
      schema: "bastamp.ai-provenance/v1",
      model: input.model,
      ...(input.modelVersion != null ? { modelVersion: input.modelVersion } : {}),
      promptHash,
      outputHash,
      generatedAt,
      ...(input.params != null ? { params: input.params } : {}),
      ...(input.metadata != null ? { metadata: input.metadata } : {}),
    };

    const manifestCanon = canonicalize(manifest);
    const manifestHash = "0x" + (await sha256Hex(manifestCanon));

    const short = manifestHash.slice(2, 10);
    const fileName = `ai-provenance-${sanitize(input.model)}-${short}.json`;

    const stamp = await this.#client.stamps.create(
      {
        contentHash: manifestHash,
        fileName,
        fileSize: manifestCanon.length,
        mimeType: "application/x-bastamp-ai-provenance",
      },
      options,
    );

    return { manifest, manifestCanon, manifestHash, stamp };
  }

  /**
   * Build the canonical manifest + hash for an AI generation, WITHOUT
   * anchoring it. Useful when the caller wants to inspect the hash before
   * paying a credit, or when batching many attestations to anchor with
   * `client.stamps.createBatch` instead.
   */
  async build(input: AttestInput): Promise<{
    manifest: AiProvenanceManifest;
    manifestCanon: string;
    manifestHash: string;
  }> {
    // Reuse the same logic by extracting the pre-stamp part. Duplicated
    // intentionally rather than refactored, to keep `attest` linear-
    // readable — the function is small.
    if (!input.model) throw new TypeError("attest: `model` is required");
    if ((input.prompt == null) === (input.promptHash == null)) {
      throw new TypeError("attest: provide exactly one of `prompt` or `promptHash`");
    }
    if ((input.output == null) === (input.outputHash == null)) {
      throw new TypeError("attest: provide exactly one of `output` or `outputHash`");
    }
    const promptHash = input.promptHash ?? (await hashFile(toBytes(input.prompt!)));
    const outputHash = input.outputHash ?? (await hashFile(toBytes(input.output!)));
    validateHash(promptHash, "promptHash");
    validateHash(outputHash, "outputHash");
    const generatedAt =
      typeof input.generatedAt === "string"
        ? input.generatedAt
        : (input.generatedAt ?? new Date()).toISOString();
    const manifest: AiProvenanceManifest = {
      schema: "bastamp.ai-provenance/v1",
      model: input.model,
      ...(input.modelVersion != null ? { modelVersion: input.modelVersion } : {}),
      promptHash,
      outputHash,
      generatedAt,
      ...(input.params != null ? { params: input.params } : {}),
      ...(input.metadata != null ? { metadata: input.metadata } : {}),
    };
    const manifestCanon = canonicalize(manifest);
    const manifestHash = "0x" + (await sha256Hex(manifestCanon));
    return { manifest, manifestCanon, manifestHash };
  }
}

// ── canonicalization ──

/**
 * Canonical JSON: sorted keys at every depth, no whitespace. MUST match
 * the implementation on bastamp.com's /verify page (verify-upload.tsx)
 * and in the stamp-extension service worker — otherwise the hash on chain
 * won't match what verifiers recompute.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

// ── helpers ──

function toBytes(input: Hashable): Uint8Array | ArrayBuffer | Blob | Buffer | ReadableStream<Uint8Array> {
  if (typeof input === "string") return new TextEncoder().encode(input);
  return input;
}

function validateHash(hash: string, field: string): void {
  if (!/^0x[0-9a-f]{64}$/.test(hash)) {
    throw new TypeError(`attest: ${field} must match 0x[0-9a-f]{64} (got "${hash.slice(0, 12)}…")`);
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 32);
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
