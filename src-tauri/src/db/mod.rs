//! On-disk SQLite cache for IMAP envelopes.
//!
//! The cache exists to make first paint instant and to reduce repeat IMAP
//! traffic on every refresh. Senders are *not* stored — they're re-derived
//! in memory from cached envelopes via the existing `aggregate_senders`
//! pipeline so there is one source of truth for the grouping rules.
//!
//! Identity: every row is keyed by `(account_key, mailbox)` where
//! `account_key = "host:port:username"` lowercased. The same
//! fingerprint that `state::ConnFingerprint` already uses to decide
//! when to reconnect.

pub mod error;

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension, Transaction};

pub use crate::db::error::CacheError;
use crate::imap::client::EnvelopeRecord;
use crate::imap::types::EmailEnvelope;

/// Identity of one (account, mailbox) pair as stored in the cache.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountMailbox {
    pub account_key: String,
    pub mailbox: String,
}

impl AccountMailbox {
    pub fn new(host: &str, port: u16, username: &str, mailbox: &str) -> Self {
        Self {
            account_key: format!(
                "{}:{}:{}",
                host.to_ascii_lowercase(),
                port,
                username.to_ascii_lowercase(),
            ),
            mailbox: mailbox.to_owned(),
        }
    }
}

/// Per-mailbox sync bookkeeping. UIDVALIDITY is the IMAP rotation
/// counter — when it changes, all UIDs in the cache become meaningless
/// and must be dropped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MailboxMeta {
    pub uid_validity: u32,
    pub uid_next: Option<u32>,
    pub exists_count: Option<u32>,
    pub last_synced_at: i64,
}

/// Cloneable handle to the SQLite cache. The single connection is
/// guarded by a `Mutex`; rusqlite is sync, and every IMAP operation
/// already runs inside `tauri::async_runtime::spawn_blocking`, so we
/// never hold the guard across `.await`.
#[derive(Clone)]
pub struct Cache {
    conn: Arc<Mutex<Connection>>,
}

impl Cache {
    /// Open or create the cache file. Runs schema setup on every open
    /// so missing tables are added without explicit migration tooling.
    pub fn open(path: &Path) -> Result<Self, CacheError> {
        let conn = Connection::open(path).map_err(|e| CacheError::Open(e.to_string()))?;
        Self::from_connection(conn)
    }

    /// In-memory cache. Used by tests; also handy for the disk-failure
    /// fallback in `lib.rs::run` so the app stays usable when the data
    /// dir is unwritable.
    pub fn open_in_memory() -> Result<Self, CacheError> {
        let conn = Connection::open_in_memory().map_err(|e| CacheError::Open(e.to_string()))?;
        Self::from_connection(conn)
    }

    fn from_connection(conn: Connection) -> Result<Self, CacheError> {
        // WAL keeps writers from blocking the cache-replay reader on
        // refresh; foreign-keys is conventional even though we don't
        // declare any FKs yet.
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| CacheError::Schema(e.to_string()))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| CacheError::Schema(e.to_string()))?;
        conn.execute_batch(SCHEMA_SQL)
            .map_err(|e| CacheError::Schema(e.to_string()))?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn read_meta(&self, key: &AccountMailbox) -> Result<Option<MailboxMeta>, CacheError> {
        let conn = self.conn.lock().expect("cache mutex poisoned");
        conn.query_row(
            "SELECT uid_validity, uid_next, exists_count, last_synced_at \
             FROM mailbox_meta WHERE account_key = ?1 AND mailbox = ?2",
            params![&key.account_key, &key.mailbox],
            |row| {
                Ok(MailboxMeta {
                    uid_validity: row.get::<_, i64>(0)? as u32,
                    uid_next: row.get::<_, Option<i64>>(1)?.map(|v| v as u32),
                    exists_count: row.get::<_, Option<i64>>(2)?.map(|v| v as u32),
                    last_synced_at: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|e| CacheError::Read(e.to_string()))
    }

    pub fn write_meta(&self, key: &AccountMailbox, meta: &MailboxMeta) -> Result<(), CacheError> {
        let conn = self.conn.lock().expect("cache mutex poisoned");
        conn.execute(
            "INSERT INTO mailbox_meta \
                 (account_key, mailbox, uid_validity, uid_next, exists_count, last_synced_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT(account_key, mailbox) DO UPDATE SET \
                 uid_validity = excluded.uid_validity, \
                 uid_next = excluded.uid_next, \
                 exists_count = excluded.exists_count, \
                 last_synced_at = excluded.last_synced_at",
            params![
                &key.account_key,
                &key.mailbox,
                meta.uid_validity as i64,
                meta.uid_next.map(|v| v as i64),
                meta.exists_count.map(|v| v as i64),
                meta.last_synced_at,
            ],
        )
        .map_err(|e| CacheError::Write(e.to_string()))?;
        Ok(())
    }

    /// Read all cached envelopes as `EnvelopeRecord`s — the shape the
    /// in-memory aggregator already wants. Newest-first by UID so the
    /// frontend sees recent senders before older ones during replay.
    pub fn list_records(&self, key: &AccountMailbox) -> Result<Vec<EnvelopeRecord>, CacheError> {
        let conn = self.conn.lock().expect("cache mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT uid, from_mailbox, from_host, from_name, subject, date_raw, flags_json \
                 FROM envelopes WHERE account_key = ?1 AND mailbox = ?2 \
                 ORDER BY uid DESC",
            )
            .map_err(|e| CacheError::Read(e.to_string()))?;
        let rows = stmt
            .query_map(params![&key.account_key, &key.mailbox], |row| {
                let flags_json: String = row.get(6)?;
                let flags: Vec<String> =
                    serde_json::from_str(&flags_json).unwrap_or_default();
                Ok(EnvelopeRecord {
                    uid: row.get::<_, i64>(0)? as u32,
                    from_mailbox: row.get(1)?,
                    from_host: row.get(2)?,
                    from_name: row.get(3)?,
                    subject: row.get(4)?,
                    date: row.get(5)?,
                    is_unread: !flags.iter().any(|f| f == "\\Seen"),
                })
            })
            .map_err(|e| CacheError::Read(e.to_string()))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| CacheError::Read(e.to_string()))?);
        }
        Ok(out)
    }

    pub fn upsert_envelopes(
        &self,
        key: &AccountMailbox,
        envs: &[EmailEnvelope],
    ) -> Result<(), CacheError> {
        if envs.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock().expect("cache mutex poisoned");
        let tx = conn
            .transaction()
            .map_err(|e| CacheError::Write(e.to_string()))?;
        upsert_envelopes_in_tx(&tx, key, envs)?;
        tx.commit().map_err(|e| CacheError::Write(e.to_string()))?;
        Ok(())
    }

    /// Replace the cached `flags_json` for one or more UIDs without
    /// touching any envelope columns. Cheap path used by the warm-sync
    /// flag refresh — `(UID FLAGS)` is much smaller than a full ENVELOPE
    /// re-fetch, so we don't want to re-upsert just to update a flag.
    pub fn update_flags(
        &self,
        key: &AccountMailbox,
        updates: &[(u32, Vec<String>)],
    ) -> Result<(), CacheError> {
        if updates.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock().expect("cache mutex poisoned");
        let tx = conn
            .transaction()
            .map_err(|e| CacheError::Write(e.to_string()))?;
        {
            let mut stmt = tx
                .prepare(
                    "UPDATE envelopes SET flags_json = ?1 \
                     WHERE account_key = ?2 AND mailbox = ?3 AND uid = ?4",
                )
                .map_err(|e| CacheError::Write(e.to_string()))?;
            for (uid, flags) in updates {
                let json = serde_json::to_string(flags)?;
                stmt.execute(params![
                    json,
                    &key.account_key,
                    &key.mailbox,
                    *uid as i64,
                ])
                .map_err(|e| CacheError::Write(e.to_string()))?;
            }
        }
        tx.commit().map_err(|e| CacheError::Write(e.to_string()))?;
        Ok(())
    }

    pub fn delete_uids(&self, key: &AccountMailbox, uids: &[u32]) -> Result<(), CacheError> {
        if uids.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock().expect("cache mutex poisoned");
        let tx = conn
            .transaction()
            .map_err(|e| CacheError::Write(e.to_string()))?;
        {
            let mut stmt = tx
                .prepare(
                    "DELETE FROM envelopes \
                     WHERE account_key = ?1 AND mailbox = ?2 AND uid = ?3",
                )
                .map_err(|e| CacheError::Write(e.to_string()))?;
            for uid in uids {
                stmt.execute(params![&key.account_key, &key.mailbox, *uid as i64])
                    .map_err(|e| CacheError::Write(e.to_string()))?;
            }
        }
        tx.commit().map_err(|e| CacheError::Write(e.to_string()))?;
        Ok(())
    }

    /// Drop everything cached for this mailbox. Called when UIDVALIDITY
    /// changes — the cached UID space is invalid and must be rebuilt.
    pub fn drop_mailbox(&self, key: &AccountMailbox) -> Result<(), CacheError> {
        let mut conn = self.conn.lock().expect("cache mutex poisoned");
        let tx = conn
            .transaction()
            .map_err(|e| CacheError::Write(e.to_string()))?;
        tx.execute(
            "DELETE FROM envelopes WHERE account_key = ?1 AND mailbox = ?2",
            params![&key.account_key, &key.mailbox],
        )
        .map_err(|e| CacheError::Write(e.to_string()))?;
        tx.execute(
            "DELETE FROM mailbox_meta WHERE account_key = ?1 AND mailbox = ?2",
            params![&key.account_key, &key.mailbox],
        )
        .map_err(|e| CacheError::Write(e.to_string()))?;
        tx.commit().map_err(|e| CacheError::Write(e.to_string()))?;
        Ok(())
    }
}

fn upsert_envelopes_in_tx(
    tx: &Transaction<'_>,
    key: &AccountMailbox,
    envs: &[EmailEnvelope],
) -> Result<(), CacheError> {
    let mut stmt = tx
        .prepare(
            "INSERT INTO envelopes \
                 (account_key, mailbox, uid, subject, date_raw, message_id, in_reply_to, \
                  from_mailbox, from_host, from_name, from_json, to_json, cc_json, flags_json) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14) \
             ON CONFLICT(account_key, mailbox, uid) DO UPDATE SET \
                 subject = excluded.subject, \
                 date_raw = excluded.date_raw, \
                 message_id = excluded.message_id, \
                 in_reply_to = excluded.in_reply_to, \
                 from_mailbox = excluded.from_mailbox, \
                 from_host = excluded.from_host, \
                 from_name = excluded.from_name, \
                 from_json = excluded.from_json, \
                 to_json = excluded.to_json, \
                 cc_json = excluded.cc_json, \
                 flags_json = excluded.flags_json",
        )
        .map_err(|e| CacheError::Write(e.to_string()))?;
    for env in envs {
        let first = env.from.first();
        let from_mailbox = first.and_then(|a| a.mailbox.clone());
        let from_host = first.and_then(|a| a.host.clone());
        let from_name = first.and_then(|a| a.name.clone());
        let from_json = serde_json::to_string(&env.from)?;
        let to_json = serde_json::to_string(&env.to)?;
        let cc_json = serde_json::to_string(&env.cc)?;
        let flags_json = serde_json::to_string(&env.flags)?;
        stmt.execute(params![
            &key.account_key,
            &key.mailbox,
            env.uid as i64,
            env.subject,
            env.date,
            env.message_id,
            env.in_reply_to,
            from_mailbox,
            from_host,
            from_name,
            from_json,
            to_json,
            cc_json,
            flags_json,
        ])
        .map_err(|e| CacheError::Write(e.to_string()))?;
    }
    Ok(())
}

/// Tauri-managed wrapper. Cloneable so commands can move it into
/// `spawn_blocking` without re-locking app state.
#[derive(Clone)]
pub struct CacheState(pub Cache);

impl CacheState {
    pub fn new(cache: Cache) -> Self {
        Self(cache)
    }
    pub fn cache(&self) -> &Cache {
        &self.0
    }
}

const SCHEMA_SQL: &str = "\
CREATE TABLE IF NOT EXISTS mailbox_meta (
    account_key    TEXT NOT NULL,
    mailbox        TEXT NOT NULL,
    uid_validity   INTEGER NOT NULL,
    uid_next       INTEGER,
    exists_count   INTEGER,
    last_synced_at INTEGER NOT NULL,
    PRIMARY KEY (account_key, mailbox)
);

CREATE TABLE IF NOT EXISTS envelopes (
    account_key   TEXT NOT NULL,
    mailbox       TEXT NOT NULL,
    uid           INTEGER NOT NULL,
    subject       TEXT,
    date_raw      TEXT,
    message_id    TEXT,
    in_reply_to   TEXT,
    from_mailbox  TEXT,
    from_host     TEXT,
    from_name     TEXT,
    from_json     TEXT NOT NULL,
    to_json       TEXT,
    cc_json       TEXT,
    flags_json    TEXT NOT NULL,
    PRIMARY KEY (account_key, mailbox, uid)
);

CREATE INDEX IF NOT EXISTS envelopes_uid_desc
    ON envelopes(account_key, mailbox, uid DESC);

CREATE INDEX IF NOT EXISTS envelopes_by_sender
    ON envelopes(account_key, mailbox, from_host, from_mailbox);
";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imap::types::{EmailAddress, EmailEnvelope};

    fn key() -> AccountMailbox {
        AccountMailbox::new("imap.example.com", 993, "ada@example.com", "INBOX")
    }

    fn other_key() -> AccountMailbox {
        AccountMailbox::new("imap.example.com", 993, "ada@example.com", "Archive")
    }

    fn env(uid: u32, mailbox: &str, host: &str, seen: bool) -> EmailEnvelope {
        EmailEnvelope {
            uid,
            subject: Some(format!("subject {uid}")),
            from: vec![EmailAddress {
                name: Some("Sender".into()),
                mailbox: Some(mailbox.into()),
                host: Some(host.into()),
            }],
            to: vec![],
            cc: vec![],
            date: Some("Mon, 01 Jan 2024 00:00:00 +0000".into()),
            message_id: Some(format!("<msg-{uid}@example.com>")),
            in_reply_to: None,
            flags: if seen {
                vec!["\\Seen".into()]
            } else {
                vec![]
            },
        }
    }

    #[test]
    fn account_mailbox_lowercases_host_and_username_only() {
        let k = AccountMailbox::new("IMAP.Example.COM", 993, "Ada@Example.COM", "INBOX");
        assert_eq!(k.account_key, "imap.example.com:993:ada@example.com");
        assert_eq!(k.mailbox, "INBOX");
    }

    #[test]
    fn round_trips_envelopes_and_meta() {
        let cache = Cache::open_in_memory().unwrap();
        let k = key();

        cache
            .upsert_envelopes(&k, &[env(10, "alice", "gmail.com", true), env(11, "bob", "gmail.com", false)])
            .unwrap();
        cache
            .write_meta(
                &k,
                &MailboxMeta {
                    uid_validity: 42,
                    uid_next: Some(12),
                    exists_count: Some(2),
                    last_synced_at: 1_700_000_000,
                },
            )
            .unwrap();

        let recs = cache.list_records(&k).unwrap();
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].uid, 11); // newest-first
        assert_eq!(recs[0].from_mailbox.as_deref(), Some("bob"));
        assert!(recs[0].is_unread);
        assert_eq!(recs[1].uid, 10);
        assert!(!recs[1].is_unread);

        let meta = cache.read_meta(&k).unwrap().expect("meta present");
        assert_eq!(meta.uid_validity, 42);
        assert_eq!(meta.uid_next, Some(12));
        assert_eq!(meta.exists_count, Some(2));
        assert_eq!(meta.last_synced_at, 1_700_000_000);
    }

    #[test]
    fn upsert_replaces_existing_row_and_refreshes_flags() {
        let cache = Cache::open_in_memory().unwrap();
        let k = key();
        cache
            .upsert_envelopes(&k, &[env(1, "x", "y.com", false)])
            .unwrap();
        cache
            .upsert_envelopes(&k, &[env(1, "x", "y.com", true)])
            .unwrap();
        let recs = cache.list_records(&k).unwrap();
        assert_eq!(recs.len(), 1);
        assert!(!recs[0].is_unread, "flags must be updated, not appended");
    }

    #[test]
    fn delete_uids_removes_only_named_rows() {
        let cache = Cache::open_in_memory().unwrap();
        let k = key();
        cache
            .upsert_envelopes(
                &k,
                &[
                    env(1, "a", "b.com", true),
                    env(2, "a", "b.com", true),
                    env(3, "a", "b.com", true),
                ],
            )
            .unwrap();
        cache.delete_uids(&k, &[2]).unwrap();
        let mut sorted: Vec<u32> = cache.list_records(&k).unwrap().iter().map(|r| r.uid).collect();
        sorted.sort();
        assert_eq!(sorted, vec![1, 3]);
    }

    #[test]
    fn drop_mailbox_isolates_other_mailboxes() {
        let cache = Cache::open_in_memory().unwrap();
        let inbox = key();
        let archive = other_key();
        cache
            .upsert_envelopes(&inbox, &[env(1, "a", "b.com", true)])
            .unwrap();
        cache
            .upsert_envelopes(&archive, &[env(1, "a", "b.com", true)])
            .unwrap();
        cache
            .write_meta(
                &inbox,
                &MailboxMeta {
                    uid_validity: 1,
                    uid_next: None,
                    exists_count: None,
                    last_synced_at: 0,
                },
            )
            .unwrap();
        cache.drop_mailbox(&inbox).unwrap();
        assert!(cache.list_records(&inbox).unwrap().is_empty());
        assert!(cache.read_meta(&inbox).unwrap().is_none());
        assert_eq!(cache.list_records(&archive).unwrap().len(), 1);
    }

    #[test]
    fn update_flags_changes_only_named_uids() {
        let cache = Cache::open_in_memory().unwrap();
        let k = key();
        cache
            .upsert_envelopes(
                &k,
                &[
                    env(1, "a", "b.com", false), // unseen
                    env(2, "a", "b.com", false), // unseen
                ],
            )
            .unwrap();
        cache
            .update_flags(&k, &[(1, vec!["\\Seen".into()])])
            .unwrap();
        let recs = cache.list_records(&k).unwrap();
        let by_uid: std::collections::HashMap<u32, &EnvelopeRecord> =
            recs.iter().map(|r| (r.uid, r)).collect();
        assert!(!by_uid[&1].is_unread, "uid 1 should now be seen");
        assert!(by_uid[&2].is_unread, "uid 2 unchanged");
    }

    #[test]
    fn list_records_marks_messages_unseen_when_flag_missing() {
        let cache = Cache::open_in_memory().unwrap();
        let k = key();
        cache
            .upsert_envelopes(
                &k,
                &[
                    env(1, "a", "b.com", true),  // \Seen
                    env(2, "a", "b.com", false), // unread
                ],
            )
            .unwrap();
        let recs = cache.list_records(&k).unwrap();
        let by_uid: std::collections::HashMap<u32, &EnvelopeRecord> =
            recs.iter().map(|r| (r.uid, r)).collect();
        assert!(!by_uid[&1].is_unread);
        assert!(by_uid[&2].is_unread);
    }
}
