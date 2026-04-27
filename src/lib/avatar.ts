import { invoke } from "@tauri-apps/api/core";

import { gravatarUrl } from "./gravatar";
import { senderEmail, type SenderSummary } from "./imap";

// BIMI is the first-priority avatar source: a domain-level vector logo
// fetched once and persisted by the Rust side, so it survives across
// app restarts. If a domain has no BIMI record we fall back to a
// per-email Gravatar URL (which itself uses Gravatar's identicon
// fallback for unknown emails, so every bubble eventually has *some*
// image).

type BimiResolution =
  | { status: "found"; svgDataUrl: string }
  | { status: "missing" };

// Per-domain in-memory dedup. The Rust side caches to disk too, but
// without this every bubble in a 30-sender chunk would round-trip
// through the IPC bridge for the same hostelworld.com lookup.
const domainCache = new Map<string, Promise<BimiResolution>>();

function resolveBimi(domain: string): Promise<BimiResolution> {
  const key = domain.trim().toLowerCase();
  if (!key) return Promise.resolve({ status: "missing" });
  let pending = domainCache.get(key);
  if (!pending) {
    pending = invoke<BimiResolution>("resolve_bimi", { domain: key }).catch(
      // If the bridge call itself fails, treat it as missing so the
      // caller falls through to Gravatar instead of leaving a hole.
      () => ({ status: "missing" } as const),
    );
    domainCache.set(key, pending);
  }
  return pending;
}

export interface ResolvedAvatar {
  source: "bimi" | "gravatar";
  url: string;
}

/// Resolve the best avatar for a sender. We try BIMI on every host
/// the bubble has seen — registrable apex first, then each contributing
/// subdomain — because some brands publish BIMI only on a sending
/// subdomain (Netflix → `members.netflix.com`, not `netflix.com`). If
/// nothing hits, fall back to a Gravatar URL whose identicon fallback
/// renders something deterministic for every email.
export async function resolveAvatarForSender(
  s: SenderSummary,
): Promise<ResolvedAvatar> {
  const candidates: string[] = [];
  if (s.address.host) candidates.push(s.address.host);
  for (const h of s.hosts ?? []) {
    if (!candidates.includes(h)) candidates.push(h);
  }
  for (const domain of candidates) {
    const bimi = await resolveBimi(domain);
    if (bimi.status === "found") {
      return { source: "bimi", url: bimi.svgDataUrl };
    }
  }
  return { source: "gravatar", url: await gravatarUrl(senderEmail(s)) };
}
