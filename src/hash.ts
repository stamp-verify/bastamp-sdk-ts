/**
 * Compute the SHA-256 of any byte source and return it as a 0x-prefixed
 * lowercase hex string — the exact format the BA Stamp API expects.
 *
 * Accepts `Uint8Array`, `ArrayBuffer`, `Blob` (browser/Bun), `Buffer`
 * (Node), or anything that can be passed to `new Response()`. The
 * computation is done locally via `crypto.subtle.digest`; the bytes
 * never leave the caller's machine.
 */
export async function hashFile(
  input: Uint8Array | ArrayBuffer | Blob | Buffer | ReadableStream<Uint8Array>,
): Promise<string> {
  let bytes: ArrayBuffer;
  if (input instanceof ArrayBuffer) {
    bytes = input;
  } else if (typeof Blob !== "undefined" && input instanceof Blob) {
    bytes = await input.arrayBuffer();
  } else if (input instanceof ReadableStream) {
    bytes = await new Response(input).arrayBuffer();
  } else if (ArrayBuffer.isView(input)) {
    const view = input as Uint8Array;
    bytes = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  } else {
    throw new TypeError(
      "hashFile: expected Uint8Array, ArrayBuffer, Blob, Buffer, or ReadableStream",
    );
  }

  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return "0x" + hex;
}
