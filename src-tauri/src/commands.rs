//! Tauri command surface exposed to the frontend.
//!
//! Each `#[tauri::command]` here is a thin adapter: it pulls managed state
//! out of the Tauri context, hands the heavy lifting to a blocking worker
//! on `tauri::async_runtime::spawn_blocking` (the IMAP client is sync),
//! and converts join errors into [`ImapError::Internal`] so the frontend
//! sees a single error type per command.

use crate::avatar::{self, BimiResolution, CacheState};
use crate::db::CacheState as EnvelopeCacheState;
use crate::imap::{
    client, EmailBody, EmailEnvelope, IdleManager, ImapAuth, ImapError, ImapState, SenderEvent,
    SenderSummary,
};
use tauri::ipc::Channel;
use tauri::AppHandle;

/// Resolve a domain's BIMI logo, returning [`BimiResolution::Found`] with
/// an inline SVG `data:` URL or [`BimiResolution::Missing`].
///
/// Hits the on-disk BIMI cache first; only does the DNS + HTTPS lookup on
/// a miss. Empty / whitespace-only domains short-circuit to `Missing`.
/// Errors during lookup are folded into `Missing` rather than surfaced —
/// the frontend treats absence of a logo as a non-fatal signal.
#[tauri::command]
pub async fn resolve_bimi(
    cache: tauri::State<'_, CacheState>,
    domain: String,
) -> Result<BimiResolution, String> {
    Ok(avatar::resolve(cache.inner(), &domain).await)
}

/// One-shot sender scan for a mailbox: connects, optionally caps the scan
/// at `scan_limit` most-recent messages, and returns the aggregated
/// per-sender summaries in a single response.
///
/// Use [`stream_senders`] when the UI needs incremental rendering or
/// cache replay; this command is the simpler all-at-once variant and
/// performs no caching.
#[tauri::command]
pub async fn list_senders(
    state: tauri::State<'_, ImapState>,
    host: String,
    port: u16,
    auth: ImapAuth,
    mailbox: String,
    scan_limit: Option<u32>,
) -> Result<Vec<SenderSummary>, ImapError> {
    let slot = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        client::list_senders(&slot, host, port, auth, mailbox, scan_limit)
    })
    .await
    .map_err(|e| ImapError::Internal(e.to_string()))?
}

/// Streaming variant of [`list_senders`]: emits cached results first
/// (Phase 0 replay), then connects and streams server-side updates as
/// [`SenderEvent`] messages over `on_event`, terminating with
/// [`SenderEvent::Done`].
///
/// Set `skip_replay = true` for IDLE-triggered refreshes where the UI
/// already holds the cached state — Phase 0 is then suppressed but cached
/// records still seed the in-memory accumulator so display names and
/// latest-UID resolution stay consistent.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn stream_senders(
    state: tauri::State<'_, ImapState>,
    cache_state: tauri::State<'_, EnvelopeCacheState>,
    host: String,
    port: u16,
    auth: ImapAuth,
    mailbox: String,
    scan_limit: Option<u32>,
    skip_replay: Option<bool>,
    on_event: Channel<SenderEvent>,
) -> Result<(), ImapError> {
    let slot = state.0.clone();
    let cache = cache_state.cache().clone();
    let skip_replay = skip_replay.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        client::stream_senders(
            &slot,
            &cache,
            host,
            port,
            auth,
            mailbox,
            scan_limit,
            skip_replay,
            on_event,
        )
    })
    .await
    .map_err(|e| ImapError::Internal(e.to_string()))?
}

/// Fetch envelope metadata for messages whose `From` matches
/// `from_address`, newest first, optionally truncated to `limit`.
///
/// Tries server-side `UID SEARCH FROM` first and falls back to a
/// client-side scan when the server returns an unparseable response
/// (e.g. ProtonMail Bridge).
#[tauri::command]
pub async fn fetch_emails_from_sender(
    state: tauri::State<'_, ImapState>,
    host: String,
    port: u16,
    auth: ImapAuth,
    mailbox: String,
    from_address: String,
    limit: Option<u32>,
) -> Result<Vec<EmailEnvelope>, ImapError> {
    let slot = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        client::fetch_from_sender(&slot, host, port, auth, mailbox, from_address, limit)
    })
    .await
    .map_err(|e| ImapError::Internal(e.to_string()))?
}

/// Fetch envelopes for a known set of UIDs in `mailbox`. Returns an empty
/// vec for an empty `uids` input without contacting the server.
///
/// Used by the bubble drill-down path, which already holds the recent
/// UIDs from the prior sender scan and so can skip a `SEARCH` round trip.
#[tauri::command]
pub async fn fetch_envelopes_by_uids(
    state: tauri::State<'_, ImapState>,
    host: String,
    port: u16,
    auth: ImapAuth,
    mailbox: String,
    uids: Vec<u32>,
) -> Result<Vec<EmailEnvelope>, ImapError> {
    let slot = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        client::fetch_envelopes_by_uids(&slot, host, port, auth, mailbox, uids)
    })
    .await
    .map_err(|e| ImapError::Internal(e.to_string()))?
}

/// Start the background IMAP IDLE worker for `(host, port, username,
/// mailbox)`. Re-issuing with the same fingerprint is a no-op; a
/// different fingerprint stops the existing worker first.
///
/// On a server-reported mailbox change the worker emits a Tauri
/// `imap-update` event and the frontend re-runs `stream_senders` to pull
/// the delta. The worker itself does not deliver message data.
#[tauri::command]
pub fn start_imap_idle(
    app: AppHandle,
    idle: tauri::State<'_, IdleManager>,
    host: String,
    port: u16,
    auth: ImapAuth,
    mailbox: String,
) {
    idle.start(app, host, port, auth, mailbox);
}

/// Signal the IDLE worker to exit and join its thread. Idempotent —
/// safe to call when no worker is running. Worst-case latency before the
/// worker observes the stop is ~60s (one IDLE check interval).
#[tauri::command]
pub fn stop_imap_idle(idle: tauri::State<'_, IdleManager>) {
    idle.stop();
}

/// Fetch the full body for `uid`, returning the parsed [`EmailBody`]
/// (HTML/plaintext, inline parts, attachments).
///
/// Side effect: this issues `BODY[]` (not `.PEEK`), which the server
/// treats as marking the message `\Seen` — the post-fetch flag set is
/// written back through to the local envelope cache so the next launch's
/// replay reflects the read state.
#[tauri::command]
pub async fn fetch_email_body(
    state: tauri::State<'_, ImapState>,
    cache_state: tauri::State<'_, EnvelopeCacheState>,
    host: String,
    port: u16,
    auth: ImapAuth,
    mailbox: String,
    uid: u32,
) -> Result<EmailBody, ImapError> {
    let slot = state.0.clone();
    let cache = cache_state.cache().clone();
    tauri::async_runtime::spawn_blocking(move || {
        client::fetch_body(&slot, &cache, host, port, auth, mailbox, uid)
    })
    .await
    .map_err(|e| ImapError::Internal(e.to_string()))?
}
