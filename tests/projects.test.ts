import { describe, expect, it } from "vitest";
import { BAStamp } from "../src/client.js";
import { canonicalize } from "../src/ai-provenance.js";
import type { ProjectManifest } from "../src/projects.js";

interface FakeFetchCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: (Response | Error)[]): {
  fetch: typeof globalThis.fetch;
  calls: FakeFetchCall[];
} {
  const calls: FakeFetchCall[] = [];
  let i = 0;
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = responses[i++];
    if (r === undefined) throw new Error(`fakeFetch: no response for call ${i}`);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch: fetchImpl as unknown as typeof globalThis.fetch, calls };
}

/**
 * Build a batch response. Each item in `items` becomes a result; the
 * server's response shape is { results: StampResult[], creditsCharged,
 * duplicateCount }.
 */
function batchResponse(items: { contentHash: string; fileName?: string | null; duplicate?: boolean }[]): Response {
  const results = items.map((it, idx) => ({
    ownershipId: `o${idx}`,
    stampId: `s${idx}`,
    contentHash: it.contentHash,
    fileName: it.fileName ?? null,
    duplicate: it.duplicate ?? false,
  }));
  const creditsCharged = items.filter((it) => !it.duplicate).length;
  const duplicateCount = items.filter((it) => it.duplicate).length;
  return new Response(
    JSON.stringify({ results, creditsCharged, duplicateCount }),
    { status: 201, headers: { "Content-Type": "application/json" } },
  );
}

const HASH_A = "0x" + "a".repeat(64);
const HASH_B = "0x" + "b".repeat(64);
const HASH_C = "0x" + "c".repeat(64);

describe("projects.stamp", () => {
  it("submits N+1 items (N file stamps + manifest) to /api/v1/stamps/batch", async () => {
    const hashHello = await sha256OfString("hello");
    const hashWorld = await sha256OfString("world");
    const { fetch, calls } = fakeFetch([
      batchResponse([
        { contentHash: hashHello, fileName: "chapter-01.md" },
        { contentHash: hashWorld, fileName: "chapter-02.md" },
        { contentHash: "0xmanifest" /* will be replaced below */, fileName: "project-…" },
      ]),
    ]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });

    const r = await c.projects.stamp({
      name: "Book manuscript v1",
      description: "Two chapters as of submission",
      files: [
        { name: "chapter-01.md", content: new TextEncoder().encode("hello") },
        { name: "chapter-02.md", content: new TextEncoder().encode("world") },
      ],
      createdAt: "2026-05-13T12:00:00.000Z",
    });

    expect(r.manifest.schema).toBe("bastamp.project/v1");
    expect(r.manifest.files).toHaveLength(2);
    expect(r.fileStamps).toHaveLength(2);
    expect(r.manifestStamp).toBeDefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/api/v1/stamps/batch");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.items).toHaveLength(3);   // 2 files + 1 manifest
    expect(body.items[0].contentHash).toBe(hashHello);
    expect(body.items[0].fileName).toBe("chapter-01.md");
    expect(body.items[1].contentHash).toBe(hashWorld);
    expect(body.items[2].contentHash).toBe(r.manifestHash);
    expect(body.items[2].mimeType).toBe("application/x-bastamp-project");
    expect(body.items[2].fileName).toMatch(/^project-Book_manuscript_v1-[0-9a-f]{8}\.json$/);
  });

  it("returns creditsCharged from the batch response (== N+1 when nothing duplicated)", async () => {
    const { fetch } = fakeFetch([
      batchResponse([
        { contentHash: HASH_A },
        { contentHash: HASH_B },
        { contentHash: HASH_C },
      ]),
    ]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    const r = await c.projects.stamp({
      name: "p",
      files: [
        { name: "a", sha256: HASH_A },
        { name: "b", sha256: HASH_B },
      ],
    });
    expect(r.creditsCharged).toBe(3); // 2 files + manifest, none duplicated
    expect(r.duplicateCount).toBe(0);
  });

  it("propagates duplicate flag — re-stamping an owned file doesn't double-charge", async () => {
    const { fetch } = fakeFetch([
      batchResponse([
        { contentHash: HASH_A, duplicate: true },   // already owned
        { contentHash: HASH_B },
        { contentHash: HASH_C },
      ]),
    ]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    const r = await c.projects.stamp({
      name: "p",
      files: [
        { name: "a", sha256: HASH_A },
        { name: "b", sha256: HASH_B },
      ],
    });
    expect(r.creditsCharged).toBe(2); // 1 new file + manifest, 1 file was dup
    expect(r.duplicateCount).toBe(1);
    expect(r.fileStamps[0]!.duplicate).toBe(true);
    expect(r.fileStamps[1]!.duplicate).toBe(false);
  });

  it("preserves file order in the submitted batch (each file's stamp is at the same index in fileStamps)", async () => {
    const hashes = [HASH_C, HASH_A, HASH_B];
    const { fetch, calls } = fakeFetch([
      batchResponse([
        { contentHash: HASH_C, fileName: "c.md" },
        { contentHash: HASH_A, fileName: "a.md" },
        { contentHash: HASH_B, fileName: "b.md" },
        { contentHash: "0xmanifest", fileName: "project-…" },
      ]),
    ]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    const r = await c.projects.stamp({
      name: "p",
      files: [
        { name: "c.md", sha256: HASH_C },
        { name: "a.md", sha256: HASH_A },
        { name: "b.md", sha256: HASH_B },
      ],
    });
    expect(r.manifest.files.map((f) => f.name)).toEqual(["c.md", "a.md", "b.md"]);
    expect(r.fileStamps.map((s) => s.contentHash)).toEqual(hashes);
  });

  it("rejects empty files array", async () => {
    const c = new BAStamp({ apiKey: "ba_live_test", fetch: fakeFetch([]).fetch });
    await expect(
      c.projects.stamp({ name: "p", files: [] }),
    ).rejects.toThrow(/non-empty/);
  });

  it("rejects > 99 files (batch endpoint caps at 100 incl. manifest)", async () => {
    const c = new BAStamp({ apiKey: "ba_live_test", fetch: fakeFetch([]).fetch });
    const files = Array.from({ length: 100 }, (_, i) => ({
      name: `f${i}.txt`,
      sha256: HASH_A,
    }));
    await expect(c.projects.stamp({ name: "p", files })).rejects.toThrow(/99/);
  });

  it("accepts exactly 99 files", async () => {
    const { fetch } = fakeFetch([
      batchResponse(Array.from({ length: 100 }, (_, i) => ({ contentHash: `0x${i.toString(16).padStart(64, "0")}` }))),
    ]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    const files = Array.from({ length: 99 }, (_, i) => ({ name: `f${i}.txt`, sha256: HASH_A }));
    const r = await c.projects.stamp({ name: "p", files });
    expect(r.fileStamps).toHaveLength(99);
  });

  it("rejects a file with neither content nor sha256", async () => {
    const c = new BAStamp({ apiKey: "ba_live_test", fetch: fakeFetch([]).fetch });
    await expect(
      c.projects.stamp({ name: "p", files: [{ name: "a.txt" }] }),
    ).rejects.toThrow(/exactly one of/);
  });

  it("rejects a file with both content AND sha256", async () => {
    const c = new BAStamp({ apiKey: "ba_live_test", fetch: fakeFetch([]).fetch });
    await expect(
      c.projects.stamp({
        name: "p",
        files: [{ name: "a.txt", content: new Uint8Array([1, 2, 3]), sha256: HASH_A }],
      }),
    ).rejects.toThrow(/exactly one of/);
  });

  it("rejects malformed pre-computed hash", async () => {
    const c = new BAStamp({ apiKey: "ba_live_test", fetch: fakeFetch([]).fetch });
    await expect(
      c.projects.stamp({
        name: "p",
        files: [{ name: "a.txt", sha256: "not-a-hash" }],
      }),
    ).rejects.toThrow(/sha256/);
  });

  it("rejects when project name is missing", async () => {
    const c = new BAStamp({ apiKey: "ba_live_test", fetch: fakeFetch([]).fetch });
    await expect(
      // @ts-expect-error intentional
      c.projects.stamp({ files: [{ name: "a", sha256: HASH_A }] }),
    ).rejects.toThrow(/name/);
  });

  it("manifestStamp.contentHash equals the locally-computed manifestHash", async () => {
    const { fetch } = fakeFetch([
      batchResponse([
        { contentHash: HASH_A, fileName: "a" },
        // The manifest stamp's contentHash must match what we computed.
        // The fakeFetch can't know it in advance — capture from the batch
        // request and echo back. We use a placeholder for the test and
        // assert separately on the SDK's behavior.
      ]),
    ]);
    // For this test we need a smarter response. Let's wire it in-band:
    let captured = "";
    const c = new BAStamp({
      apiKey: "ba_live_test",
      fetch: (async (_url: string, init: RequestInit = {}) => {
        const body = JSON.parse(init.body as string);
        captured = body.items[body.items.length - 1].contentHash;
        return batchResponse([
          { contentHash: HASH_A, fileName: "a" },
          { contentHash: captured, fileName: "project-…" },
        ]);
      }) as unknown as typeof globalThis.fetch,
    });
    const r = await c.projects.stamp({
      name: "p",
      files: [{ name: "a", sha256: HASH_A }],
      createdAt: "2026-05-13T00:00:00.000Z",
    });
    expect(r.manifestStamp.contentHash).toBe(r.manifestHash);
    expect(r.manifestHash).toBe(captured);
  });

  it("a verifier recomputing canonical SHA-256 from the manifest gets back manifestHash", async () => {
    const captureAndEcho = (async (_url: string, init: RequestInit = {}) => {
      const body = JSON.parse(init.body as string);
      const manifestHash = body.items[body.items.length - 1].contentHash;
      return batchResponse([
        { contentHash: HASH_A, fileName: "a.md" },
        { contentHash: HASH_B, fileName: "b.md" },
        { contentHash: manifestHash, fileName: "project-…" },
      ]);
    }) as unknown as typeof globalThis.fetch;
    const c = new BAStamp({ apiKey: "ba_live_test", fetch: captureAndEcho });
    const r = await c.projects.stamp({
      name: "p",
      files: [
        { name: "a.md", sha256: HASH_A },
        { name: "b.md", sha256: HASH_B },
      ],
      createdAt: "2026-05-13T00:00:00.000Z",
    });
    const recomputedCanon = canonicalize(r.manifest);
    expect(await sha256OfString(recomputedCanon)).toBe(r.manifestHash);
  });
});

describe("projects.build", () => {
  it("returns manifest + hash WITHOUT calling the API", async () => {
    const { fetch, calls } = fakeFetch([]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    const r = await c.projects.build({
      name: "p",
      files: [{ name: "a", sha256: HASH_A }],
      createdAt: "2026-05-13T00:00:00.000Z",
    });
    expect(r.manifest.schema).toBe("bastamp.project/v1");
    expect(r.manifestHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(calls).toHaveLength(0);
  });
});

// Compile-time sanity
const _typeCheck: ProjectManifest = {
  schema: "bastamp.project/v1",
  name: "x",
  createdAt: "2026-05-13T00:00:00Z",
  files: [{ name: "a", sha256: HASH_A }],
};
void _typeCheck;

// ── helpers ──

async function sha256OfString(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return "0x" + Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
