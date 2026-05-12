import { describe, expect, it } from "vitest";
import { hashFile } from "../src/hash.js";

// Reference: echo -n "" | sha256sum → empty-string SHA-256
const EMPTY_SHA256 = "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
// Reference: echo -n "hello" | sha256sum
const HELLO_SHA256 = "0x2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

describe("hashFile", () => {
  it("hashes an empty Uint8Array to the known empty-string SHA-256", async () => {
    expect(await hashFile(new Uint8Array(0))).toBe(EMPTY_SHA256);
  });

  it("hashes 'hello' to the known value regardless of input wrapper", async () => {
    const fromBytes = await hashFile(new TextEncoder().encode("hello"));
    const fromArrayBuffer = await hashFile(new TextEncoder().encode("hello").buffer as ArrayBuffer);
    const fromBlob = await hashFile(new Blob([new TextEncoder().encode("hello")]));
    expect(fromBytes).toBe(HELLO_SHA256);
    expect(fromArrayBuffer).toBe(HELLO_SHA256);
    expect(fromBlob).toBe(HELLO_SHA256);
  });

  it("produces 0x + 64 lowercase hex chars (66 total)", async () => {
    const h = await hashFile(new TextEncoder().encode("anything"));
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h).toHaveLength(66);
  });

  it("hashes a Node Buffer the same as the underlying bytes", async () => {
    const buf = Buffer.from("hello", "utf8");
    expect(await hashFile(buf)).toBe(HELLO_SHA256);
  });

  it("hashes a ReadableStream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hel"));
        controller.enqueue(new TextEncoder().encode("lo"));
        controller.close();
      },
    });
    expect(await hashFile(stream)).toBe(HELLO_SHA256);
  });

  it("rejects unsupported input types", async () => {
    // @ts-expect-error — intentionally wrong
    await expect(hashFile("a string" as unknown)).rejects.toThrow(TypeError);
  });

  it("operates on a 64KB buffer without surprises (large-ish payload)", async () => {
    const bytes = new Uint8Array(64 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const h = await hashFile(bytes);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    // Same bytes → same hash, deterministic
    expect(await hashFile(bytes)).toBe(h);
  });
});
