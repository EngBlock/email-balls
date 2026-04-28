mod avatar;
mod commands;
mod db;
mod imap;

use tauri::Manager;

use crate::avatar::CacheState;
use crate::db::{Cache, CacheState as EnvelopeCacheState};
use crate::imap::{IdleManager, ImapState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ImapState::default())
        .manage(IdleManager::default())
        .setup(|app| {
            let app_data = app
                .path()
                .app_local_data_dir()
                .expect("missing app local data dir");
            std::fs::create_dir_all(&app_data).ok();

            let salt_path = app_data.join("salt.txt");
            app.handle().plugin(
                tauri_plugin_stronghold::Builder::with_argon2(&salt_path).build(),
            )?;

            // BIMI cache lives next to the salt file in app_local_data;
            // load it once at startup so subsequent lookups are O(1)
            // hits when a domain has been seen before.
            let cache = CacheState::load(app_data.join("bimi-cache.json"));
            app.manage(cache);

            // Envelope cache. Falls back to an in-memory database if the
            // SQLite file fails to open — the app stays usable, just
            // without persistence across restarts.
            let envelope_cache = match Cache::open(&app_data.join("mail-cache.sqlite")) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("envelope cache: falling back to in-memory ({e})");
                    Cache::open_in_memory().expect("in-memory cache should always open")
                }
            };
            app.manage(EnvelopeCacheState::new(envelope_cache));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_senders,
            commands::stream_senders,
            commands::fetch_emails_from_sender,
            commands::fetch_envelopes_by_uids,
            commands::fetch_email_body,
            commands::resolve_bimi,
            commands::start_imap_idle,
            commands::stop_imap_idle,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
