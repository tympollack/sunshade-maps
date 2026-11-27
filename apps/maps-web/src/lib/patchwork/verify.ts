/**
 * SHA-256 evidence verification. A node records the SHA-256 of the evidence image at
 * verification time; a reviewer can re-hash a local copy and compare it to that record.
 * Uses WebCrypto (`crypto.subtle`), available in browsers and Node 20+.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** True for a 64-character hexadecimal digest (case-insensitive). */
export function isValidSha256(value: string | null | undefined): value is string {
  return typeof value === "string" && SHA256_HEX.test(value.trim().toLowerCase());
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type HashVerification =
  | { status: "no-record" }
  | { status: "malformed-record" }
  | { status: "match"; computed: string }
  | { status: "mismatch"; computed: string };

/** Compares a computed digest against the node's recorded hash. */
export function compareHash(recorded: string | null, computed: string): HashVerification {
  if (!recorded) return { status: "no-record" };
  if (!isValidSha256(recorded)) return { status: "malformed-record" };
  return recorded.trim().toLowerCase() === computed.toLowerCase()
    ? { status: "match", computed }
    : { status: "mismatch", computed };
}
