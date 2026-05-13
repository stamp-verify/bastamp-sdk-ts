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

function stampResponse(contentHash: string): Response {
  return new Response(
    JSON.stringify({
      stamp: { ownershipId: "o1", stampId: "s1", contentHash, fileName: null, duplicate: false },
      creditsCharged: 1,
    }),
    { status: 201, headers: { "Content-Type": "application/json" } },
  );
}

const HASH_A = "0x" + "a".repeat(64);
const HASH_B = "0x" + "b".repeat(64);
const HASH_C = "0x" + "c".repeat(64);

describe("projects.stamp", () => {
  it("hashes file contents locally, builds canonical manifest, POSTs to /api/v1/stamps", async () => {
    const { fetch, calls } = fakeFetch([stampResponse("0xdeadbeef")]);
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
    expect(r.manifest.name).toBe("Book manuscript v1");
    expect(r.manifest.description).toBe("Two chapters as of submission");
    expect(r.manifest.createdAt).toBe("2026-05-13T12:00:00.000Z");
    expect(r.manifest.files).toHaveLength(2);
    expect(r.manifest.files[0]!.name).toBe("chapter-01.md");
    expect(r.manifest.files[0]!.sha256).toMatch(/^0x[0-9a-f]{64}$/);

    expect(r.manifestCanon).toBe(canonicalize(r.manifest));
    expect(r.manifestHash).toMatch(/^0x[0-9a-f]{64}$/);

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.contentHash).toBe(r.manifestHash);
    expect(body.mimeType).toBe("application/x-bastamp-project");
    expect(body.fileName).toMatch(/^project-Book_manuscript_v1-[0-9a-f]{8}\.json$/);
  });

  it("accepts pre-computed sha256 per file (no content needed)", async () => {
    const { fetch } = fakeFetch([stampResponse("0xx")]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    const r = await c.projects.stamp({
      name: "case-2025-0042",
      files: [
        { name: "doc-1.pdf", sha256: HASH_A, size: 12345 },
        { name: "doc-2.pdf", sha256: HASH_B, size: 67890 },
      ],
    });
    expect(r.manifest.files[0]!.sha256).toBe(HASH_A);
    expect(r.manifest.files[0]!.size).toBe(12345);
    expect(r.manifest.files[1]!.sha256).toBe(HASH_B);
  });

  it("defaults createdAt to now if not provided", async () => {
    const { fetch } = fakeFetch([stampResponse("0xx")]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    const before = Date.now();
    const r = await c.projects.stamp({
      name: "p",
      files: [{ name: "a", sha256: HASH_A }],
    });
    const after = Date.now();
    const t = new Date(r.manifest.createdAt).getTime();
    expect(t).toBeGreaterThanOrEqual(before - 1);
    expect(t).toBeLessThanOrEqual(after + 1);
  });

  it("preserves file order (a verifier expects deterministic order in the array)", async () => {
    const { fetch } = fakeFetch([stampResponse("0xx")]);
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
  });

  it("rejects empty files array", async () => {
    const c = new BAStamp({ apiKey: "ba_live_test", fetch: fakeFetch([]).fetch });
    await expect(
      c.projects.stamp({ name: "p", files: [] }),
    ).rejects.toThrow(/non-empty/);
  });

  it("rejects > 10000 files", async () => {
    const c = new BAStamp({ apiKey: "ba_live_test", fetch: fakeFetch([]).fetch });
    const files = Array.from({ length: 10001 }, (_, i) => ({
      name: `f${i}.txt`,
      sha256: HASH_A,
    }));
    await expect(c.projects.stamp({ name: "p", files })).rejects.toThrow(/10000/);
  });

  it("rejects a file with neither content nor sha256", async () => {
    const c = new BAStamp({ apiKey: "ba_live_test", fetch: fakeFetch([]).fetch });
    await expect(
      c.projects.stamp({
        name: "p",
        files: [{ name: "a.txt" }],
      }),
    ).rejects.toThrow(/exactly one of/);
  });

  it("rejects a file with both content AND sha256 (ambiguous intent)", async () => {
    const c = new BAStamp({ apiKey: "ba_live_test", fetch: fakeFetch([]).fetch });
    await expect(
      c.projects.stamp({
        name: "p",
        files: [{ name: "a.txt", content: new Uint8Array([1, 2, 3]), sha256: HASH_A }],
      }),
    ).rejects.toThrow(/exactly one of/);
  });

  it("rejects a malformed pre-computed hash", async () => {
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

  it("sanitizes project name in the generated fileName", async () => {
    const { fetch, calls } = fakeFetch([stampResponse("0xx")]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    await c.projects.stamp({
      name: "Case #42 / 2025 — final",
      files: [{ name: "a", sha256: HASH_A }],
    });
    const body = JSON.parse(calls[0]!.init.body as string) as { fileName: string };
    expect(body.fileName).toMatch(/^project-Case__42___2025___final-[0-9a-f]{8}\.json$/);
  });

  it("same input produces same manifestHash (deterministic)", async () => {
    const { fetch } = fakeFetch([stampResponse("0xx"), stampResponse("0xx")]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    const input = {
      name: "p",
      files: [
        { name: "a.md", sha256: HASH_A },
        { name: "b.md", sha256: HASH_B },
      ],
      createdAt: "2026-05-13T00:00:00.000Z",
    };
    const r1 = await c.projects.stamp(input);
    const r2 = await c.projects.stamp(input);
    expect(r1.manifestHash).toBe(r2.manifestHash);
  });

  it("a verifier recomputing canonical SHA-256 from the manifest gets back manifestHash", async () => {
    const { fetch } = fakeFetch([stampResponse("0xx")]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    const r = await c.projects.stamp({
      name: "p",
      files: [
        { name: "a.md", sha256: HASH_A },
        { name: "b.md", sha256: HASH_B },
      ],
      createdAt: "2026-05-13T00:00:00.000Z",
    });
    const recomputedCanon = canonicalize(r.manifest);
    const bytes = new TextEncoder().encode(recomputedCanon);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const recomputedHash =
      "0x" + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(recomputedHash).toBe(r.manifestHash);
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
