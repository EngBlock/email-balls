import { Channel, invoke } from "@tauri-apps/api/core";

export interface EmailAddress {
  name: string | null;
  mailbox: string | null;
  host: string | null;
}

export interface SenderSummary {
  address: EmailAddress;
  displayName: string | null;
  messageCount: number;
  /** Subset of `messageCount` whose IMAP flags lacked `\Seen` at scan time.
   *  Drives the unread-badge on bubbles. */
  unreadCount: number;
  latestUid: number;
  latestSubject: string | null;
  latestDate: string | null;
  /** UIDs of this sender's messages within the scanned window, newest-first.
   *  Pass straight to {@link fetchEnvelopesByUids} to skip a slow SEARCH. */
  uids: number[];
  /** All distinct sending hosts that fed this bubble. For domain-grouped
   *  bubbles this carries the original subdomains so the avatar resolver
   *  can fall back to a sending subdomain when the registrable apex has
   *  no BIMI (e.g. Netflix publishes BIMI on `members.netflix.com`, not
   *  `netflix.com`). For consumer-mail bubbles this is a single-element
   *  list with that mailbox's host. */
  hosts: string[];
}

export interface EmailEnvelope {
  uid: number;
  subject: string | null;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  date: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  flags: string[];
}

export interface AttachmentInfo {
  filename: string | null;
  contentType: string;
  size: number;
}

/** A MIME part carrying a Content-ID, referenced from the HTML body via
 *  `<img src="cid:…">`. The renderer rewrites those URLs to `data:` URLs
 *  using {@link InlinePart.dataBase64} so the iframe resolves them
 *  without a network request. `contentId` arrives bracket-stripped to
 *  match the form HTML uses (i.e. `logo@host`, not `<logo@host>`). */
export interface InlinePart {
  contentId: string;
  contentType: string;
  dataBase64: string;
}

export interface EmailBody {
  uid: number;
  subject: string | null;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  date: string | null;
  textBody: string | null;
  htmlBody: string | null;
  attachments: AttachmentInfo[];
  inlineParts: InlinePart[];
}

export type ImapAuth = {
  kind: "password";
  username: string;
  password: string;
};

export interface AccountConn {
  host: string;
  port: number;
  auth: ImapAuth;
  mailbox: string;
}

export type ImapErrorKind =
  | "connect"
  | "auth"
  | "mailbox"
  | "search"
  | "fetch"
  | "parse"
  | "notFound"
  | "internal";

export interface ImapInvocationError {
  kind: ImapErrorKind;
  message: string;
}

export function listSenders(
  account: AccountConn,
  scanLimit?: number,
): Promise<SenderSummary[]> {
  return invoke<SenderSummary[]>("list_senders", { ...account, scanLimit });
}

export type SenderEvent =
  | { kind: "started"; total: number; scan: number }
  | { kind: "chunk"; senders: SenderSummary[] }
  | { kind: "done" };

export function streamSenders(
  account: AccountConn,
  scanLimit: number | undefined,
  onEvent: (event: SenderEvent) => void,
): Promise<void> {
  const channel = new Channel<SenderEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("stream_senders", {
    ...account,
    scanLimit,
    onEvent: channel,
  });
}

function senderKey(s: SenderSummary): string {
  const m = (s.address.mailbox ?? "").toLowerCase();
  const h = (s.address.host ?? "").toLowerCase();
  return `${m}@${h}`;
}

export function mergeSenders(
  prev: SenderSummary[],
  delta: SenderSummary[],
): SenderSummary[] {
  const map = new Map(prev.map((s) => [senderKey(s), s]));
  for (const s of delta) map.set(senderKey(s), s);
  return Array.from(map.values()).sort((a, b) => b.latestUid - a.latestUid);
}

export function fetchEmailsFromSender(
  account: AccountConn,
  fromAddress: string,
  limit?: number,
): Promise<EmailEnvelope[]> {
  return invoke<EmailEnvelope[]>("fetch_emails_from_sender", {
    ...account,
    fromAddress,
    limit,
  });
}

export function fetchEnvelopesByUids(
  account: AccountConn,
  uids: number[],
): Promise<EmailEnvelope[]> {
  return invoke<EmailEnvelope[]>("fetch_envelopes_by_uids", {
    ...account,
    uids,
  });
}

export function fetchEmailBody(
  account: AccountConn,
  uid: number,
): Promise<EmailBody> {
  return invoke<EmailBody>("fetch_email_body", { ...account, uid });
}

// Domain-grouped bubbles (one per brand host) come back from the
// backend with `mailbox: null` — render them as just the host so we
// don't show "@vercel.com" in tooltips or hash a bare-`@` string for
// avatars. Per-mailbox bubbles still render the full address.
export function senderLabel(s: SenderSummary): string {
  if (s.displayName) return s.displayName;
  const m = s.address.mailbox ?? "";
  const h = s.address.host ?? "";
  if (!m && h) return h;
  return h ? `${m}@${h}` : m;
}

export function senderEmail(s: SenderSummary): string {
  const m = s.address.mailbox ?? "";
  const h = s.address.host ?? "";
  if (!m && h) return h;
  return h ? `${m}@${h}` : m;
}
