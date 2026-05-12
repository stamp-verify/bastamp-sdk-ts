// Run with: npx tsx examples/basic.ts
// (requires BASTAMP_API_KEY env var)

import { readFile } from "node:fs/promises";
import { BAStamp, hashFile, BAStampNoCreditsError } from "../src/index.js";

const apiKey = process.env.BASTAMP_API_KEY;
if (!apiKey) {
  console.error("Set BASTAMP_API_KEY (create one at https://bastamp.com/account/api-keys)");
  process.exit(1);
}

const client = new BAStamp({ apiKey });

// Account info — credits remaining.
const account = await client.account.get();
console.log(`account ${account.id}, credits=${account.credits}`);

// Hash a file (locally — bytes never leave the machine) and stamp it.
const path = process.argv[2];
if (!path) {
  console.error("Usage: tsx examples/basic.ts <path-to-file>");
  process.exit(1);
}

const bytes = await readFile(path);
const contentHash = await hashFile(bytes);
console.log(`hashed ${path} → ${contentHash}`);

try {
  const { stamp, creditsCharged } = await client.stamps.create({
    contentHash,
    fileName: path.split("/").pop(),
    fileSize: bytes.length,
    mimeType: "application/octet-stream",
  });
  console.log(
    stamp.duplicate
      ? `already owned (no credit charged), ownership ${stamp.ownershipId}`
      : `stamped (1 credit), ownership ${stamp.ownershipId}`,
  );
  console.log(`charged: ${creditsCharged}`);
} catch (err) {
  if (err instanceof BAStampNoCreditsError) {
    console.error("Out of credits — top up at https://bastamp.com/#pricing");
    process.exit(2);
  }
  throw err;
}

// Poll the stamp's status (anchored on Polygon usually within 5 minutes).
const result = await client.stamps.get(contentHash);
console.log(`status: ${result.status}`);
if (result.anchor) {
  console.log(`anchored on ${result.anchor.chain}, tx ${result.anchor.txHash}`);
}
