use crate::avatar::{self, BimiResolution, CacheState};
use crate::imap::{
    client, EmailBody, EmailEnvelope, ImapAuth, ImapError, ImapState, SenderEvent, SenderSummary,
};
use tauri::ipc::Channel;

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
pub async fn stream_senders(
    state: tauri::State<'_, ImapState>,
    host: String,
    port: u16,
    auth: ImapAuth,
    mailbox: String,
    scan_limit: Option<u32>,
    on_event: Channel<SenderEvent>,
) -> Result<(), ImapError> {
    let slot = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        client::stream_senders(&slot, host, port, auth, mailbox, scan_limit, on_event)
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
pub async fn fetch_email_body(
    state: tauri::State<'_, ImapState>,
    host: String,
    port: u16,
    auth: ImapAuth,
    mailbox: String,
    uid: u32,
) -> Result<EmailBody, ImapError> {
    let slot = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        client::fetch_body(&slot, host, port, auth, mailbox, uid)
    })
    .await
    .map_err(|e| ImapError::Internal(e.to_string()))?
}
