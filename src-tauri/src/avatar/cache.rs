//! Disk-backed BIMI cache. Single JSON file in the app data dir, loaded
//! once at startup and rewritten after each new lookup. The file is
//! small (one entry per domain we've ever queried), so blasting the
//! whole map out on each write is fine and gives us crash-safety with
//! zero extra ceremony.
//!
//! TTLs:
//! - `Found`   — 7 days  (logos rarely change)
//! - `Missing` — 24 hours (most domains will never publish BIMI; a day
//!   feels like the right "give it another try" cadence without
//!   hammering DNS)

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::BimiResolution;

const FOUND_TTL_SECS: u64 = 7 * 24 * 60 * 60;
const MISSING_TTL_SECS: u64 = 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum Entry {
    Found {
        svg_data_url: String,
        fetched_at: u64,
    },
    Missing {
        fetched_at: u64,
    },
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CacheFile {
    entries: HashMap<String, Entry>,
}

pub struct CacheState {
    path: PathBuf,
    inner: Mutex<CacheFile>,
}

impl CacheState {
    pub fn load(path: PathBuf) -> Self {
        let inner = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<CacheFile>(&bytes).ok())
            .unwrap_or_default();
        Self {
            path,
            inner: Mutex::new(inner),
        }
    }

    pub fn get_fresh(&self, domain: &str) -> Option<BimiResolution> {
        let now = now_secs();
        let guard = self.inner.lock().ok()?;
        let entry = guard.entries.get(domain)?;
        match entry {
            Entry::Found {
                svg_data_url,
                fetched_at,
            } if now.saturating_sub(*fetched_at) < FOUND_TTL_SECS => {
                Some(BimiResolution::Found {
                    svg_data_url: svg_data_url.clone(),
                })
            }
            Entry::Missing { fetched_at } if now.saturating_sub(*fetched_at) < MISSING_TTL_SECS => {
                Some(BimiResolution::Missing)
            }
            _ => None,
        }
    }

    pub fn put(&self, domain: &str, resolution: &BimiResolution) {
        let now = now_secs();
        let snapshot = {
            let Ok(mut guard) = self.inner.lock() else { return };
            let entry = match resolution {
                BimiResolution::Found { svg_data_url } => Entry::Found {
                    svg_data_url: svg_data_url.clone(),
                    fetched_at: now,
                },
                BimiResolution::Missing => Entry::Missing { fetched_at: now },
            };
            guard.entries.insert(domain.to_string(), entry);
            // Clone under the lock so the file write happens unlocked
            // — the disk write is the slow part and other lookups can
            // keep flowing while it's in flight.
            CacheFile {
                entries: guard.entries.clone(),
            }
        };
        let _ = persist(&self.path, &snapshot);
    }
}

fn persist(path: &PathBuf, file: &CacheFile) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(file)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, bytes)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fresh_cache_in(dir: &std::path::Path) -> CacheState {
        CacheState::load(dir.join("bimi.json"))
    }

    #[test]
    fn missing_returns_none_when_not_in_cache() {
        let dir = tempdir().unwrap();
        let cache = fresh_cache_in(dir.path());
        assert!(cache.get_fresh("example.com").is_none());
    }

    #[test]
    fn put_then_get_round_trips_found() {
        let dir = tempdir().unwrap();
        let cache = fresh_cache_in(dir.path());
        let r = BimiResolution::Found {
            svg_data_url: "data:image/svg+xml;base64,PHN2Zy8+".into(),
        };
        cache.put("example.com", &r);
        match cache.get_fresh("example.com") {
            Some(BimiResolution::Found { svg_data_url }) => {
                assert_eq!(svg_data_url, "data:image/svg+xml;base64,PHN2Zy8+");
            }
            other => panic!("expected Found, got {other:?}"),
        }
    }

    #[test]
    fn put_persists_across_reloads() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("bimi.json");
        {
            let cache = CacheState::load(path.clone());
            cache.put("example.com", &BimiResolution::Missing);
        }
        let cache = CacheState::load(path);
        assert!(matches!(
            cache.get_fresh("example.com"),
            Some(BimiResolution::Missing)
        ));
    }

    #[test]
    fn corrupt_cache_file_is_treated_as_empty() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("bimi.json");
        std::fs::write(&path, b"{not json").unwrap();
        let cache = CacheState::load(path);
        assert!(cache.get_fresh("example.com").is_none());
    }

    #[test]
    fn stale_found_entry_is_treated_as_miss() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("bimi.json");
        // Write a doctored entry whose fetched_at is older than the TTL.
        let stale_fetched_at = now_secs().saturating_sub(FOUND_TTL_SECS + 1);
        let mut entries = HashMap::new();
        entries.insert(
            "example.com".to_string(),
            Entry::Found {
                svg_data_url: "data:image/svg+xml;base64,PHN2Zy8+".into(),
                fetched_at: stale_fetched_at,
            },
        );
        std::fs::write(
            &path,
            serde_json::to_vec(&CacheFile { entries }).unwrap(),
        )
        .unwrap();
        let cache = CacheState::load(path);
        assert!(cache.get_fresh("example.com").is_none());
    }

    #[test]
    fn stale_missing_entry_is_treated_as_miss() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("bimi.json");
        let stale = now_secs().saturating_sub(MISSING_TTL_SECS + 1);
        let mut entries = HashMap::new();
        entries.insert(
            "example.com".to_string(),
            Entry::Missing { fetched_at: stale },
        );
        std::fs::write(
            &path,
            serde_json::to_vec(&CacheFile { entries }).unwrap(),
        )
        .unwrap();
        let cache = CacheState::load(path);
        assert!(cache.get_fresh("example.com").is_none());
    }
}
