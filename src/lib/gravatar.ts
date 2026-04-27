// Gravatar's avatar endpoint accepts SHA-256 hashes of the lowercased
// email. WebCrypto handles SHA-256 natively, so we don't need an MD5 dep.
// `?d=identicon` returns a deterministic geometric pattern for unknown
// emails — every sender renders something, no fallback needed.

const cache = new Map<string, string>();

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function gravatarUrl(email: string, size = 160): Promise<string> {
  const key = email.trim().toLowerCase();
  let hash = cache.get(key);
  if (!hash) {
    hash = await sha256Hex(key);
    cache.set(key, hash);
  }
  return `https://gravatar.com/avatar/${hash}?s=${size}&d=identicon`;
}

/// Deterministic HSL backdrop shown while the Gravatar image loads, so a
/// bubble is never visually empty. Cheap rolling hash — quality doesn't
/// matter as long as it's stable per-email.
export function hashColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360}, 55%, 65%)`;
}
