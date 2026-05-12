import { describe, expect, it } from "vitest";
import { BAStamp } from "../src/client.js";
import { canonicalize, type AiProvenanceManifest } from "../src/ai-provenance.js";

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

describe("canonicalize", () => {
  it("sorts object keys at every depth and emits no whitespace", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("handles primitives + null", () => {
    expect(canonicalize("hi")).toBe('"hi"');
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
  });

  it("two objects with same content but different key order produce identical canonical form", () => {
    const a = { schema: "x", model: "m", promptHash: "0x", outputHash: "0x" };
    const b = { outputHash: "0x", promptHash: "0x", model: "m", schema: "x" };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });
});

describe("aiProvenance.attest", () => {
  it("hashes prompt + output, builds canonical manifest, POSTs to /api/v1/stamps", async () => {
    const { fetch, calls } = fakeFetch([stampResponse("0xdeadbeef")]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });

    const r = await c.aiProvenance.attest({
      model: "gpt-5",
      modelVersion: "2026-04-15",
      prompt: "Summarize this paragraph briefly.",
      output: "TL;DR — this is the summary.",
      generatedAt: "2026-05-12T12:00:00.000Z",
      params: { temperature: 0.7, seed: 42 },
    });

    // Manifest shape
    expect(r.manifest.schema).toBe("bastamp.ai-provenance/v1");
    expect(r.manifest.model).toBe("gpt-5");
    expect(r.manifest.modelVersion).toBe("2026-04-15");
    expect(r.manifest.promptHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.manifest.outputHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.manifest.generatedAt).toBe("2026-05-12T12:00:00.000Z");
    expect(r.manifest.params).toEqual({ temperature: 0.7, seed: 42 });

    // Canonical form must round-trip via canonicalize
    expect(r.manifestCanon).toBe(canonicalize(r.manifest));

    // Hash must be 0x + 64 lowercase hex
    expect(r.manifestHash).toMatch(/^0x[0-9a-f]{64}$/);

    // POST happened to /api/v1/stamps with correct body shape
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.contentHash).toBe(r.manifestHash);
    expect(body.mimeType).toBe("application/x-bastamp-ai-provenance");
    expect(body.fileName).toMatch(/^ai-provenance-gpt-5-[0-9a-f]{8}\.json$/);
    expect(body.fileSize).toBe(r.manifestCanon.length);
  });

  it("accepts pre-computed promptHash / outputHash (private-prompt mode)", async () => {
    const { fetch } = fakeFetch([stampResponse("0xanything")]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    const pre = "0x" + "a".repeat(64);
    const r = await c.aiProvenance.attest({
      model: "claude-opus-4-7",
      promptHash: pre,
      outputHash: pre,
    });
    expect(r.manifest.promptHash).toBe(pre);
    expect(r.manifest.outputHash).toBe(pre);
  });

  it("defaults generatedAt to now when not provided", async () => {
    const { fetch } = fakeFetch([stampResponse("0xx")]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    const before = new Date();
    const r = await c.aiProvenance.attest({
      model: "gpt-5",
      prompt: "x",
      output: "y",
    });
    const after = new Date();
    const t = new Date(r.manifest.generatedAt).getTime();
    expect(t).toBeGreaterThanOrEqual(before.getTime() - 1);
    expect(t).toBeLessThanOrEqual(after.getTime() + 1);
  });

  it("omits optional fields from the manifest when not provided (deterministic shape)", async () => {
    const { fetch } = fakeFetch([stampResponse("0xx")]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    const r = await c.aiProvenance.attest({
      model: "gpt-5",
      prompt: "x",
      output: "y",
      generatedAt: "2026-05-12T00:00:00.000Z",
    });
    expect("modelVersion" in r.manifest).toBe(false);
    expect("params" in r.manifest).toBe(false);
    expect("metadata" in r.manifest).toBe(false);
  });

  it("throws when both prompt AND promptHash are passed", async () => {
    const c = new BAStamp({ apiKey: "ba_live_test", fetch: fakeFetch([]).fetch });
    await expect(
      c.aiProvenance.attest({
        model: "gpt-5",
        prompt: "x",
        promptHash: "0x" + "0".repeat(64),
        output: "y",
      }),
    ).rejects.toThrow(/exactly one of `prompt`/);
  });

  it("throws when neither output nor outputHash is passed", async () => {
    const c = new BAStamp({ apiKey: "ba_live_test", fetch: fakeFetch([]).fetch });
    await expect(
      c.aiProvenance.attest({ model: "gpt-5", prompt: "x" }),
    ).rejects.toThrow(/exactly one of `output`/);
  });

  it("throws when a pre-computed hash has wrong format", async () => {
    const c = new BAStamp({ apiKey: "ba_live_test", fetch: fakeFetch([]).fetch });
    await expect(
      c.aiProvenance.attest({
        model: "gpt-5",
        promptHash: "notahash",
        outputHash: "0x" + "0".repeat(64),
      }),
    ).rejects.toThrow(/promptHash/);
  });

  it("throws when model is missing", async () => {
    const c = new BAStamp({ apiKey: "ba_live_test", fetch: fakeFetch([]).fetch });
    await expect(
      c.aiProvenance.attest({
        // @ts-expect-error intentional
        model: undefined,
        prompt: "x",
        output: "y",
      }),
    ).rejects.toThrow(/model/);
  });

  it("sanitizes model name in the generated fileName (no slashes, no spaces)", async () => {
    const { fetch, calls } = fakeFetch([stampResponse("0xx")]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    await c.aiProvenance.attest({
      model: "org/weird name@v2",
      prompt: "x",
      output: "y",
    });
    const body = JSON.parse(calls[0]!.init.body as string) as { fileName: string };
    expect(body.fileName).toMatch(/^ai-provenance-org_weird_name_v2-[0-9a-f]{8}\.json$/);
  });

  it("same input twice produces same manifestHash (deterministic)", async () => {
    const { fetch } = fakeFetch([stampResponse("0xx"), stampResponse("0xx")]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    const r1 = await c.aiProvenance.attest({
      model: "gpt-5",
      promptHash: "0x" + "a".repeat(64),
      outputHash: "0x" + "b".repeat(64),
      generatedAt: "2026-05-12T00:00:00.000Z",
    });
    const r2 = await c.aiProvenance.attest({
      model: "gpt-5",
      promptHash: "0x" + "a".repeat(64),
      outputHash: "0x" + "b".repeat(64),
      generatedAt: "2026-05-12T00:00:00.000Z",
    });
    expect(r1.manifestHash).toBe(r2.manifestHash);
    expect(r1.manifestCanon).toBe(r2.manifestCanon);
  });
});

describe("aiProvenance.build (no anchoring)", () => {
  it("returns manifest + hash WITHOUT calling the API", async () => {
    const { fetch, calls } = fakeFetch([]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    const r = await c.aiProvenance.build({
      model: "gpt-5",
      prompt: "x",
      output: "y",
      generatedAt: "2026-05-12T00:00:00.000Z",
    });
    expect(r.manifest.schema).toBe("bastamp.ai-provenance/v1");
    expect(r.manifestHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(calls).toHaveLength(0);
  });
});

describe("manifest verifiability round-trip", () => {
  it("a verifier recomputing canonical SHA-256 from the manifest gets back manifestHash", async () => {
    const { fetch } = fakeFetch([stampResponse("0xx")]);
    const c = new BAStamp({ apiKey: "ba_live_test", fetch });
    const r = await c.aiProvenance.attest({
      model: "gpt-5",
      prompt: "test prompt",
      output: "test output",
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    // Simulate the verify-page side: have the manifest object, canonicalize,
    // SHA-256, compare. The recomputed hash must match what we sent on chain.
    const recomputedCanon = canonicalize(r.manifest);
    const bytes = new TextEncoder().encode(recomputedCanon);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const recomputedHash = "0x" + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");

    expect(recomputedHash).toBe(r.manifestHash);
  });
});

// Compile-time sanity — make sure the exported type is what we documented.
const _typeCheck: AiProvenanceManifest = {
  schema: "bastamp.ai-provenance/v1",
  model: "gpt-5",
  promptHash: "0x" + "0".repeat(64),
  outputHash: "0x" + "0".repeat(64),
  generatedAt: "2026-05-12T00:00:00.000Z",
};
void _typeCheck;
