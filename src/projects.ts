import type { BAStamp } from "./client.js";
import type { CreateStampResponse, RequestOptions } from "./types.js";
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
  manifestHash: string;
  stamp: CreateStampResponse;
}

const MAX_FILES = 10_000;

export class ProjectsResource {
  readonly #client: BAStamp;
  constructor(client: BAStamp) {
    this.#client = client;
  }

  /**
   * Stamp a multi-file project as a single on-chain unit. Builds a
   * canonical manifest committing to every file's SHA-256, hashes it,
   * anchors the hash via /api/v1/stamps. Charges 1 credit regardless of
   * the number of files in the project.
   *
   * ```ts
   * const r = await client.projects.stamp({
   *   name: "Book manuscript v1",
   *   description: "12 chapters as of submission",
   *   files: [
   *     { name: "chapter-01.md", content: await readFile("chapter-01.md") },
   *     { name: "chapter-02.md", content: await readFile("chapter-02.md") },
   *     // …
   *   ],
   * });
   *
   * // Save the manifest with the project — it's the verification artifact.
   * await fs.writeFile("project.manifest.json", JSON.stringify(r.manifest, null, 2));
   * console.log("anchored hash:", r.manifestHash);
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
    const fileName = `project-${sanitize(input.name)}-${short}.json`;

    const stamp = await this.#client.stamps.create(
      {
        contentHash: manifestHash,
        fileName,
        fileSize: manifestCanon.length,
        mimeType: "application/x-bastamp-project",
      },
      options,
    );

    return { manifest, manifestCanon, manifestHash, stamp };
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
