/**
 * Fountain keys at rest. Each user's key is encrypted with AES-256-GCM under
 * a key derived from `SALON_SECRET`, so a copy of the database alone is not a
 * copy of everyone's Fountain access. Session tokens are stored only as
 * SHA-256 hashes for the same reason.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export class Cipher {
  private constructor(private readonly key: CryptoKey) {}

  static async from(secret: string): Promise<Cipher> {
    if (secret.length < 16) throw new Error("SALON_SECRET must be at least 16 characters");
    const digest = await crypto.subtle.digest("SHA-256", enc.encode(secret));
    const key = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    return new Cipher(key);
  }

  /** `v1.<iv>.<ciphertext>`, both base64url. */
  async encrypt(plain: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.key, enc.encode(plain));
    return `v1.${b64(iv)}.${b64(new Uint8Array(ct))}`;
  }

  async decrypt(stored: string): Promise<string> {
    const [v, ivB, ctB] = stored.split(".");
    if (v !== "v1" || !ivB || !ctB) throw new Error("unrecognised ciphertext");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(ivB) }, this.key, unb64(ctB));
    return dec.decode(pt);
  }
}

export function randomToken(bytes = 32): string {
  return b64(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(s: string): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
