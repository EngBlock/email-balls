# Architecture

Email Balls is a Tauri 2 desktop app: a Rust core that talks IMAP and resolves
avatars, plus a React 19 + Vite frontend that renders senders as physics-driven
bubbles. This document describes the major seams as they exist today.

## Tauri command boundary

`src-tauri/src/lib.rs` wires the app: it registers managed state
(`ImapState`, `IdleManager`, BIMI `CacheState`, envelope `CacheState`),
initialises the Stronghold plugin (its salt lives in `app_local_data_dir`),
and registers eight commands declared in `src-tauri/src/commands.rs`:

- `list_senders`, `stream_senders` — scan a mailbox and aggregate senders.
- `fetch_emails_from_sender`, `fetch_envelopes_by_uids` — list envelopes.
- `fetch_email_body` — return parsed HTML/text plus inline parts.
- `resolve_bimi` — domain → BIMI logo.
- `start_imap_idle`, `stop_imap_idle` — control the IDLE worker.

Commands are thin wrappers. The IMAP-touching ones run inside
`tauri::async_runtime::spawn_blocking` because the underlying `imap` crate is
synchronous. Errors are returned as `Result<T, ImapError>` (an enum with
`kind`/`message` that the TS layer narrows in `src/lib/imap.ts`).

If the SQLite envelope cache fails to open, `lib.rs` falls back to an
in-memory cache so the app stays usable without restart-persistence.

## IMAP module shape (`src-tauri/src/imap/`)

- `mod.rs` — re-exports the public surface (`ImapAuth`, `ImapError`,
  `ImapState`, `IdleManager`, `EmailBody`, `EmailEnvelope`, `SenderEvent`,
  `SenderSummary`).
- `auth.rs` — `ImapAuth` is a `#[serde(tag = "kind")]` enum with one
  variant today (`Password { username, password }`). The shape is set up
  for an OAuth2 variant later without breaking the IPC schema.
- `client.rs` — the heavy module. Header decoding (RFC 2047 via
  `mail-parser`), sender aggregation rules (per-mailbox vs. domain-grouped
  bubbles), `list_senders` / `stream_senders` (Channel-driven delta sync
  against the envelope cache), `fetch_from_sender`,
  `fetch_envelopes_by_uids`, and `fetch_body` (with a 10 MB cap on inline
  parts shipped over IPC).
- `idle.rs` — a *second* IMAP session pinned to its own thread. While a
  session is in IDLE it can't run any other command, so the foreground
  session stays untouched. The worker emits a `imap-update` Tauri event on
  `MailboxChanged`; the frontend reacts by re-running `stream_senders`.
  Reconnects use exponential backoff (1s → 30s); shutdown latency is
  bounded by a 60s IDLE re-issue interval.
- `state.rs` — `HandleSlot` holds at most one persistent foreground
  session, keyed by `ConnFingerprint { host, port, username }`. It
  remembers the currently-selected mailbox so back-to-back commands skip
  the `SELECT` round trip. `run_with_session` is the single entry point
  that locks the slot, ensures readiness, runs the closure, and
  invalidates the slot on any error so the next caller reconnects from
  scratch.
- `error.rs` — `ImapError` (Connect / Auth / Mailbox / Search / Fetch /
  Parse / NotFound / Internal). Serialised with a `kind`/`message` shape
  the frontend type-narrows.
- `types.rs` — IPC payload structs (`EmailAddress`, `SenderSummary`,
  `EmailEnvelope`, `EmailBody`, `InlinePart`, `AttachmentInfo`,
  `SenderEvent`).

## Envelope cache (`src-tauri/src/db/`)

A SQLite file at `<app_local_data_dir>/mail-cache.sqlite`, accessed through
a single `Connection` behind a `Mutex` (rusqlite is sync; we never hold
the guard across `.await`). The schema is created on every open — there is
no migration tool, just `CREATE TABLE IF NOT EXISTS`.

Two tables, both keyed by `(account_key, mailbox)` where
`account_key = "host:port:username"` lowercased:

- `mailbox_meta` — `uid_validity`, `uid_next`, `exists_count`,
  `last_synced_at`. UIDVALIDITY rotation drops the cached envelopes for
  that mailbox.
- `envelopes` — one row per `(account, mailbox, uid)` with the parsed
  envelope plus `from_host` / `from_mailbox` (denormalised for the
  per-sender query path) and `flags_json`.

Senders are *not* stored. They are re-derived in memory from envelopes by
the same `aggregate_senders` pipeline that powers a fresh scan, so there
is one source of truth for grouping rules.

## Avatar resolution (`src-tauri/src/avatar/` + frontend fallback)

Sender bubbles get their image from a two-stage pipeline:

1. **BIMI** (Rust). `avatar/bimi.rs` queries DNS TXT at
   `default._bimi.<domain>`, parses the `l=` field, then HTTPS-GETs the
   SVG (≤ 256 KB, 5s timeout). VMC chain validation and DMARC alignment
   are intentionally skipped — this is a personal client, not a brand
   verifier. `avatar/cache.rs` persists hits and misses to a JSON file in
   `app_local_data_dir` (TTL: 7 days for found, 24 hours for missing).
   `avatar/mod.rs` exposes `BimiResolution::Found { svgDataUrl }` /
   `Missing` over IPC. The `rename_all_fields = "camelCase"` annotation
   is load-bearing — see the test in `mod.rs`.
2. **Gravatar** (frontend). `src/lib/avatar.ts` walks every host the
   bubble has seen (registrable apex first, then each contributing
   subdomain, because some brands publish BIMI only on a sending
   subdomain). On every miss it falls back to a Gravatar URL built from
   the SHA-256 of the lowercased email (`src/lib/gravatar.ts`), with
   `?d=identicon` so unknown emails still get a deterministic image.
   An in-memory promise cache dedupes per-domain BIMI calls so a 30-bubble
   chunk doesn't round-trip the IPC bridge thirty times for the same
   domain.

## Secure HTML rendering (`src/components/EmailHtmlFrame.tsx`)

Email HTML is hostile by default. The render pipeline:

1. **Sanitise** with DOMPurify. Forbid `script`, `iframe`, `object`,
   `embed`, `form`, `meta`, `link`, `base`. A custom
   `uponSanitizeAttribute` hook (a) rewrites `cid:` URLs in `src` /
   `background` to `data:` URLs from the backend's `inlineParts`,
   (b) parks real `<a href>` URLs on `data-href` and replaces the
   attribute with `"#"` so the link physically can't navigate the
   iframe, and (c) strips `target` to keep the WebView from attempting
   popups Tauri swallows.
2. **Collapse quoted replies.** `collapseQuotes` wraps Apple Mail
   `blockquote[type=cite]`, Gmail `.gmail_quote`, and the Outlook
   `#divRplyFwdMsg` divider in `<details class="email-quote">` so the
   visible message starts at the latest reply.
3. **Assemble a document** with a strict CSP `<meta>`:
   `default-src 'none'; img-src data:[ https:]; style-src 'unsafe-inline';
   font-src data:`. `https:` is appended only when the user has opted
   into remote images for that view, so tracking pixels stay dormant
   until then.
4. **Render in an iframe** via `srcdoc` with
   `sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"`.
   No `allow-scripts`, no `allow-forms`, no `allow-top-navigation`. The
   `allow-same-origin` is intentional: it lets the parent measure
   `documentElement.scrollHeight` via a `ResizeObserver` and bind a
   capture-phase click handler that routes link activations through
   `@tauri-apps/plugin-opener` to the system browser.

## Frontend data flow

State lives in `src/App.tsx` as plain React hooks (`useState` / `useRef`
/ `useEffect`). There is no external store — no Redux, no zustand. The
top-level component owns: the connection form, the active `AccountConn`,
the senders list, the selected sender, the email envelope list for that
sender, and the currently-open body. Two ref-tracked sequence numbers
(`senderFetchSeqRef`, `bodyFetchSeqRef`) drop stale results when the user
clicks through quickly.

Persistence is split:

- **Credentials** — `src/lib/accountStore.ts` writes the form fields to
  `localStorage` under `mail-bubbles:account-v1`. It is cleartext today;
  the Stronghold plugin is wired into `lib.rs` but not yet used. This is
  fine for a localhost ProtonMail Bridge setup and called out in code as
  a thing to harden before broader distribution.
- **Envelopes** — the SQLite cache above; the frontend never sees it
  directly. `streamSenders` emits a `started` event with the cached
  total so first paint is instant on subsequent runs.

Push updates flow through `IdleManager` → `imap-update` Tauri event →
`onImapUpdate` listener in `App.tsx`, which debounces bursts and drops
overlapping refreshes (a still-running `streamSenders` absorbs whatever
the next notification would have caught).

UI cascade: `SenderBubbles` (d3-force layout, framer-motion animations) →
`EmailListDrawer` → `EmailBodyDrawer` (which embeds `EmailHtmlFrame` for
HTML or `EmailTextBody` for plain text).
