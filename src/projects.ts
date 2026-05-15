import type { BAStamp } from "./client.js";
import type { RequestOptions, StampResult } from "./types.js";
import { hashFile } from "./hash.js";
import { canonicalize } from "./ai-provenance.js";

/**
 * Canonical manifest format BA | Stamp anchors when stamping a project
 * (a folder, a release, a case file — any set of files that belongs
 * together). The hash anchored on chain is the SHA-256 of the
 * canonicalized manifest. Verification of any single file: recompute
 * the file's SHA-256, find it in `files[].sha256`, confirm the manifest
 * hash matches the on-chain anchor.
 *
 * Flat list rather than a Merkle tree-of-trees. For projects up to
 * ~10k files the manifest stays under 1 MB and is parseable on any
 * verifier device. Larger projects can move to a tree if pull demands.
 */
export interface ProjectManifest {
  readonly schema: "bastamp.project/v1";
  name: string;
  description?: string;
  createdAt: string;
  files: ProjectFileEntry[];
  metadata?: Record<string, unknown>;
}

export interface ProjectFileEntry {
  /** Human-readable filename (relative path is fine; preserve hierarchy if it matters). */
  name: string;
  /** SHA-256 of the file's bytes, 0x-prefixed lowercase. */
  sha256: string;
  /** Optional: file size in bytes. */
  size?: number;
  /** Optional: MIME type, metadata only. */
  mimeType?: string;
}

type Hashable = Uint8Array | ArrayBuffer | Blob | Buffer | ReadableStream<Uint8Array>;

export interface ProjectFileInput {
  /** Filename (or relative path). */
  name: string;
  /**
   * Either pass `content` (the SDK hashes it locally — bytes never leave
   * your machine) or `sha256` (you've already hashed it). Exactly one.
   */
  content?: Hashable;
  sha256?: string;
  size?: number;
  mimeType?: string;
}

export interface StampProjectInput {
  name: string;
  description?: string;
  files: ProjectFileInput[];
  createdAt?: Date | string;
  metadata?: Record<string, unknown>;
}

export interface StampProjectResult {
  manifest: ProjectManifest;
  manifestCanon: string;
  /** SHA-256 of the canonicalized manifest. Same as `manifestStamp.contentHash`. */
  manifestHash: string;
  /** The manifest's own stamp result (1 credit). */
  manifestStamp: StampResult;
  /** One stamp result per file, in the same order as `manifest.files`. */
  fileStamps: StampResult[];
  /** Total credits charged across all stamps in this project (N+1 minus duplicates). */
  creditsCharged: number;
  /** Files for which the caller already owned a stamp — no credit charged. */
  duplicateCount: number;
}

// Capped to fit a single /v1/stamps/batch call (max 100 items) plus the
// manifest stamp. Future versions can chunk for larger projects.
const MAX_FILES = 99;

export class ProjectsResource {
  readonly #client: BAStamp;
  constructor(client: BAStamp) {
    this.#client = client;
  }

  /**
   * Stamp a multi-file project. Each file is anchored individually (own
   * Merkle leaf, own /verify/<file-hash> URL, own certificate) AND a
   * project manifest binding them is anchored separately. Total cost is
   * N + 1 credits for N files; same per-file pricing as bulk upload plus
   * the bonus project anchor on top.
   *
   * The N+1 stamps are submitted via /api/v1/stamps/batch in a single
   * call, so they land in the same on-chain batch (atomic group).
   *
   * ```ts
   * const r = await client.projects.stamp({
   *   name: "Case 2025-0042",
   *   description: "Exhibits A through G",
   *   files: [
   *     { name: "exhibit-a.pdf", content: await readFile("exhibit-a.pdf") },
   *     { name: "exhibit-b.pdf", content: await readFile("exhibit-b.pdf") },
   *   ],
   * });
   *
   * // Per-file URLs: r.fileStamps[i] → /verify/<sha256>
   * // Project URL:   r.manifestStamp → /verify/<manifestHash>
   * await fs.writeFile("project.manifest.json", JSON.stringify(r.manifest, null, 2));
   * ```
   */
  async stamp(input: StampProjectInput, options: RequestOptions = {}): Promise<StampProjectResult> {
    if (!input.name || typeof input.name !== "string") {
      throw new TypeError("stamp: `name` is required");
    }
    if (!Array.isArray(input.files) || input.files.length === 0) {
      throw new TypeError("stamp: `files` must be a non-empty array");
    }
    if (input.files.length > MAX_FILES) {
      throw new TypeError(`stamp: max ${MAX_FILES} files per project (got ${input.files.length})`);
    }

    const fileEntries: ProjectFileEntry[] = [];
    for (let i = 0; i < input.files.length; i++) {
      const f = input.files[i]!;
      if (!f.name || typeof f.name !== "string") {
        throw new TypeError(`stamp: files[${i}].name is required`);
      }
      if ((f.content == null) === (f.sha256 == null)) {
        throw new TypeError(`stamp: files[${i}] must have exactly one of \`content\` or \`sha256\``);
      }
      const sha256 = f.sha256 ?? (await hashFile(f.content!));
      if (!/^0x[0-9a-f]{64}$/.test(sha256)) {
        throw new TypeError(`stamp: files[${i}].sha256 must match 0x[0-9a-f]{64}`);
      }
      const entry: ProjectFileEntry = { name: f.name, sha256 };
      if (f.size != null) entry.size = f.size;
      if (f.mimeType != null) entry.mimeType = f.mimeType;
      fileEntries.push(entry);
    }

    const createdAt =
      typeof input.createdAt === "string"
        ? input.createdAt
        : (input.createdAt ?? new Date()).toISOString();

    const manifest: ProjectManifest = {
      schema: "bastamp.project/v1",
      name: input.name,
      ...(input.description != null ? { description: input.description } : {}),
      createdAt,
      files: fileEntries,
      ...(input.metadata != null ? { metadata: input.metadata } : {}),
    };

    const manifestCanon = canonicalize(manifest);
    const manifestHash = "0x" + (await sha256Hex(manifestCanon));

    const short = manifestHash.slice(2, 10);
    const projectSlug = sanitize(input.name);
    const manifestFileName = `project-${projectSlug}-${short}.json`;

    // Batch: N file stamps + the manifest stamp, in that order. The
    // server processes them atomically (one batch row on chain).
    const items = [
      ...fileEntries.map((e) => ({
        contentHash: e.sha256,
        fileName: e.name,
        ...(e.size != null ? { fileSize: e.size } : {}),
        ...(e.mimeType != null ? { mimeType: e.mimeType } : {}),
      })),
      {
        contentHash: manifestHash,
        fileName: manifestFileName,
        fileSize: manifestCanon.length,
        mimeType: "application/x-bastamp-project",
      },
    ];

    const batch = await this.#client.stamps.createBatch({ items }, options);
    // Last result is the manifest (same order we submitted).
    const fileStamps = batch.results.slice(0, fileEntries.length);
    const manifestStamp = batch.results[fileEntries.length];
    if (!manifestStamp) {
      throw new Error("internal: server returned fewer stamps than submitted");
    }

    return {
      manifest,
      manifestCanon,
      manifestHash,
      manifestStamp,
      fileStamps,
      creditsCharged: batch.creditsCharged,
      duplicateCount: batch.duplicateCount,
    };
  }

  /** Build the manifest + hash WITHOUT anchoring (mirror of aiProvenance.build). */
  async build(input: StampProjectInput): Promise<{
    manifest: ProjectManifest;
    manifestCanon: string;
    manifestHash: string;
  }> {
    // Same validation as stamp() but skip the API call. Duplicated rather
    // than refactored for linear readability.
    if (!input.name) throw new TypeError("build: `name` is required");
    if (!Array.isArray(input.files) || input.files.length === 0) {
      throw new TypeError("build: `files` must be a non-empty array");
    }
    if (input.files.length > MAX_FILES) {
      throw new TypeError(`build: max ${MAX_FILES} files per project (got ${input.files.length})`);
    }
    const fileEntries: ProjectFileEntry[] = [];
    for (let i = 0; i < input.files.length; i++) {
      const f = input.files[i]!;
      if ((f.content == null) === (f.sha256 == null)) {
        throw new TypeError(`build: files[${i}] must have exactly one of \`content\` or \`sha256\``);
      }
      const sha256 = f.sha256 ?? (await hashFile(f.content!));
      if (!/^0x[0-9a-f]{64}$/.test(sha256)) {
        throw new TypeError(`build: files[${i}].sha256 must match 0x[0-9a-f]{64}`);
      }
      const entry: ProjectFileEntry = { name: f.name, sha256 };
      if (f.size != null) entry.size = f.size;
      if (f.mimeType != null) entry.mimeType = f.mimeType;
      fileEntries.push(entry);
    }
    const createdAt =
      typeof input.createdAt === "string"
        ? input.createdAt
        : (input.createdAt ?? new Date()).toISOString();
    const manifest: ProjectManifest = {
      schema: "bastamp.project/v1",
      name: input.name,
      ...(input.description != null ? { description: input.description } : {}),
      createdAt,
      files: fileEntries,
      ...(input.metadata != null ? { metadata: input.metadata } : {}),
    };
    const manifestCanon = canonicalize(manifest);
    const manifestHash = "0x" + (await sha256Hex(manifestCanon));
    return { manifest, manifestCanon, manifestHash };
  }
}

// ── helpers ──

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
