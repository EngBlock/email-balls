use crate::avatar::{self, BimiResolution, CacheState};
use crate::db::CacheState as EnvelopeCacheState;
use crate::imap::{
    client, EmailBody, EmailEnvelope, IdleManager, ImapAuth, ImapError, ImapState, SenderEvent,
    SenderSummary,
};
use tauri::ipc::Channel;
use tauri::AppHandle;

#[tauri::command]
pub async fn resolve_bimi(
    cache: tauri::State<'_, CacheState>,
    domain: String,
) -> Result<BimiResolution, String> {
    Ok(avatar::resolve(cache.inner(), &domain).await)
}

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

#[tauri::command]
pub fn stop_imap_idle(idle: tauri::State<'_, IdleManager>) {
    idle.stop();
}

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
