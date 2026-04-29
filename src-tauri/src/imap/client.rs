use std::collections::{HashMap, HashSet};
use std::net::TcpStream;
use mail_parser::MimeHeaders;

use imap::types::{Fetch, Flag};
use imap::Session;
use imap_proto::types::Address;
use native_tls::TlsStream;

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::db::{AccountMailbox, Cache, MailboxMeta};
use crate::imap::auth::ImapAuth;
use crate::imap::error::ImapError;
use crate::imap::state::{run_with_session, HandleSlot};
use crate::imap::types::{
    AttachmentInfo, EmailAddress, EmailBody, EmailEnvelope, InlinePart, SenderEvent, SenderSummary,
};
use base64::Engine;
use tauri::ipc::Channel;

/// Caps the per-message inline-part payload (sum of base64-encoded bytes
/// returned to the frontend). Marketing emails routinely embed ~100 KB of
/// inline images; abusive or pathological messages can carry tens of MB.
/// 10 MB is enough for normal mail and small enough to keep the IPC hop
/// snappy. Once exceeded we stop attaching further inline parts; the HTML
/// will fall back to a broken-image placeholder for the missing cid.
const INLINE_PARTS_TOTAL_CAP_BYTES: usize = 10 * 1024 * 1024;

fn lossy_owned(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

// Decode RFC 2047 encoded-word syntax (`=?charset?q?...?=` / `=?charset?b?...?=`)
// in header values like Subject and display names. The IMAP `ENVELOPE` response
// returns these fields with the encoded-word markers intact, so we pipe them
// through mail-parser by synthesising a one-line message and reading back the
// decoded subject. mail-parser already understands the full RFC 2047 grammar
// (Q-encoding, B-encoding, charset transcoding, whitespace folding between
// adjacent encoded words), which is more than we'd want to re-implement here.
fn decode_header_text(s: String) -> String {
    if !s.contains("=?") {
        return s;
    }
    let raw = format!("Subject: {}\r\n\r\n", s);
    mail_parser::MessageParser::default()
        .parse(raw.as_bytes())
        .and_then(|m| m.subject().map(str::to_owned))
        .unwrap_or(s)
}

fn lossy_decoded(b: &[u8]) -> String {
    decode_header_text(lossy_owned(b))
}

pub(crate) fn imap_quoted(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

fn flag_to_string(f: &Flag<'_>) -> String {
    match f {
        Flag::Seen => "\\Seen".into(),
        Flag::Answered => "\\Answered".into(),
        Flag::Flagged => "\\Flagged".into(),
        Flag::Deleted => "\\Deleted".into(),
        Flag::Draft => "\\Draft".into(),
        Flag::Recent => "\\Recent".into(),
        Flag::MayCreate => "\\MayCreate".into(),
        Flag::Custom(s) => s.to_string(),
    }
}

fn convert_imap_address(a: &Address<'_>) -> EmailAddress {
    EmailAddress {
        name: a
            .name
            .map(lossy_decoded)
            .filter(|s| !s.is_empty()),
        mailbox: a
            .mailbox
            .map(lossy_owned)
            .filter(|s| !s.is_empty()),
        host: a
            .host
            .map(lossy_owned)
            .filter(|s| !s.is_empty()),
    }
}

fn addresses_from_imap(opt: Option<&Vec<Address<'_>>>) -> Vec<EmailAddress> {
    opt.map(|v| v.iter().map(convert_imap_address).collect())
        .unwrap_or_default()
}

/// Hosts where individual mailboxes belong to individual humans, so
/// per-address grouping is what the user actually wants. Everywhere
/// else we collapse to one bubble per host. Match is exact + lowercased
/// — we don't strip subdomains here on purpose: brands routinely send
/// from a sending subdomain (`email.brand.com`), and BIMI lookups are
/// per-host, so subdomain-distinct grouping is a feature, not a bug.
const CONSUMER_DOMAINS: &[&str] = &[
    "appleid.com",
    "gmail.com",
    "googlemail.com",
    "yahoo.com",
    "yahoo.co.uk",
    "yahoo.co.jp",
    "ymail.com",
    "rocketmail.com",
    "hotmail.com",
    "hotmail.co.uk",
    "outlook.com",
    "live.com",
    "msn.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "aol.com",
    "protonmail.com",
    "proton.me",
    "pm.me",
    "fastmail.com",
    "fastmail.fm",
    "gmx.com",
    "gmx.de",
    "gmx.net",
    "gmx.at",
    "mail.com",
    "hey.com",
    "duck.com",
    "tutanota.com",
    "tuta.com",
    "zoho.com",
    "mailbox.org",
    "yandex.com",
    "yandex.ru",
    "qq.com",
    "163.com",
    "126.com",
];

/// Strip subdomains down to the registrable domain (eTLD+1) using the
/// Public Suffix List, so `updates.linear.app` and `linear.app`
/// collapse to the same key — and `members.netflix.com` rolls up
/// under `netflix.com`. PSL handles the awkward TLDs (`.co.uk`,
/// `.com.au`, `*.github.io`, etc.) correctly so we don't have to.
/// Falls back to the original lowercased host when PSL doesn't
/// recognise the input (IP literals, `localhost`, malformed hosts).
fn registrable_domain(host: &str) -> String {
    let h = host.trim().to_ascii_lowercase();
    // PSL doesn't recognise IP literals — it treats `127.0.0.1` as a
    // four-label name and trims to `0.1`. Bypass for any IPv4/IPv6.
    if h.parse::<std::net::IpAddr>().is_ok() {
        return h;
    }
    psl::domain_str(&h).map(str::to_owned).unwrap_or(h)
}

fn is_consumer_domain(host: &str) -> bool {
    let h = host.trim().to_ascii_lowercase();
    if CONSUMER_DOMAINS.iter().any(|d| *d == h) {
        return true;
    }
    // A subdomain of a consumer provider is still consumer-mail —
    // `m.gmail.com` shouldn't accidentally domain-aggregate.
    if let Some(reg) = psl::domain_str(&h) {
        return CONSUMER_DOMAINS.contains(&reg);
    }
    false
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvelopeRecord {
    pub uid: u32,
    pub from_mailbox: Option<String>,
    pub from_host: Option<String>,
    pub from_name: Option<String>,
    pub subject: Option<String>,
    pub date: Option<String>,
    /// True if the message lacked the `\Seen` flag in the scan response.
    /// Caller must have requested FLAGS in the FETCH or this is meaningless.
    pub is_unread: bool,
}

/// Merge envelope records into a running accumulator and return the senders
/// that changed in this pass. Used by both the one-shot `aggregate_senders`
/// and the streaming `stream_senders` so the grouping rules stay identical.
pub fn merge_into(
    by_key: &mut HashMap<String, SenderSummary>,
    records: impl IntoIterator<Item = EnvelopeRecord>,
) -> Vec<SenderSummary> {
    let mut touched: HashSet<String> = HashSet::new();
    for r in records {
        let mailbox = r.from_mailbox.unwrap_or_default().to_lowercase();
        let host = r.from_host.unwrap_or_default().to_lowercase();
        if mailbox.is_empty() || host.is_empty() {
            continue;
        }
        // Brand domains collapse to one bubble per registrable domain
        // (eTLD+1) so `updates.linear.app` and `linear.app` merge.
        // Consumer-mail providers (gmail, icloud, outlook, …) keep
        // per-mailbox keys so individual people stay separable. The
        // address mailbox is dropped for domain-grouped bubbles — the
        // frontend keys off `mailbox == None` to render "linear.app"
        // instead of "@linear.app".
        let consumer = is_consumer_domain(&host);
        let group_host = if consumer {
            host.clone()
        } else {
            registrable_domain(&host)
        };
        let key = if consumer {
            format!("{mailbox}@{host}")
        } else {
            group_host.clone()
        };
        let entry = by_key.entry(key.clone()).or_insert_with(|| SenderSummary {
            address: EmailAddress {
                name: None,
                mailbox: if consumer { Some(mailbox) } else { None },
                host: Some(group_host),
            },
            display_name: None,
            message_count: 0,
            unread_count: 0,
            latest_uid: 0,
            latest_subject: None,
            latest_date: None,
            uids: Vec::new(),
            hosts: Vec::new(),
        });
        // Track every distinct sending host so the frontend can try a
        // subdomain when the apex has no BIMI. Tiny memory footprint
        // (typically 1–3 hosts per bubble) and the dedup is O(n²) only
        // in the contributing-host count, not the message count.
        if !entry.hosts.contains(&host) {
            entry.hosts.push(host);
        }
        entry.message_count += 1;
        if r.is_unread {
            entry.unread_count += 1;
        }
        // Keep `uids` sorted newest-first so the frontend can hand them
        // straight to a UID-fetch and the user sees recent messages first.
        let pos = entry
            .uids
            .binary_search_by(|probe| r.uid.cmp(probe))
            .unwrap_or_else(|p| p);
        entry.uids.insert(pos, r.uid);
        if r.uid > entry.latest_uid {
            entry.latest_uid = r.uid;
            entry.latest_subject = r.subject;
            entry.latest_date = r.date;
            let name = r.from_name.filter(|s| !s.is_empty());
            if name.is_some() {
                entry.display_name = name;
            }
        }
        touched.insert(key);
    }
    touched
        .into_iter()
        .filter_map(|k| by_key.get(&k).cloned())
        .collect()
}

pub fn aggregate_senders(records: impl IntoIterator<Item = EnvelopeRecord>) -> Vec<SenderSummary> {
    let mut by_key: HashMap<String, SenderSummary> = HashMap::new();
    let _ = merge_into(&mut by_key, records);
    let mut out: Vec<SenderSummary> = by_key.into_values().collect();
    out.sort_by_key(|s| std::cmp::Reverse(s.latest_uid));
    out
}

fn record_from_fetch(f: &Fetch) -> Option<EnvelopeRecord> {
    let uid = f.uid?;
    let env = f.envelope()?;
    let from = env.from.as_ref().and_then(|v| v.first())?;
    let is_unread = !f.flags().iter().any(|fl| matches!(fl, Flag::Seen));
    Some(EnvelopeRecord {
        uid,
        from_mailbox: from.mailbox.map(lossy_owned),
        from_host: from.host.map(lossy_owned),
        from_name: from.name.map(lossy_decoded),
        subject: env.subject.map(lossy_decoded),
        date: env.date.map(lossy_owned),
        is_unread,
    })
}

fn envelope_from_fetch(uid: u32, f: &Fetch) -> EmailEnvelope {
    let env = f.envelope();
    EmailEnvelope {
        uid,
        subject: env.and_then(|e| e.subject).map(lossy_decoded),
        from: env
            .map(|e| addresses_from_imap(e.from.as_ref()))
            .unwrap_or_default(),
        to: env
            .map(|e| addresses_from_imap(e.to.as_ref()))
            .unwrap_or_default(),
        cc: env
            .map(|e| addresses_from_imap(e.cc.as_ref()))
            .unwrap_or_default(),
        date: env.and_then(|e| e.date).map(lossy_owned),
        message_id: env
            .and_then(|e| e.message_id)
            .map(lossy_owned),
        in_reply_to: env
            .and_then(|e| e.in_reply_to)
            .map(lossy_owned),
        flags: f.flags().iter().map(flag_to_string).collect(),
    }
}

pub(crate) fn split_email(full: &str) -> (Option<String>, Option<String>) {
    if full.is_empty() {
        return (None, None);
    }
    match full.rfind('@') {
        Some(i) => {
            let mb = &full[..i];
            let h = &full[i + 1..];
            let mb_o = (!mb.is_empty()).then(|| mb.to_string());
            let h_o = (!h.is_empty()).then(|| h.to_string());
            (mb_o, h_o)
        }
        None => (Some(full.to_string()), None),
    }
}

fn addr_from_parser(a: &mail_parser::Addr<'_>) -> EmailAddress {
    let (mailbox, host) = a
        .address
        .as_deref()
        .map(split_email)
        .unwrap_or((None, None));
    EmailAddress {
        name: a
            .name
            .as_deref()
            .map(str::to_owned)
            .filter(|s| !s.is_empty()),
        mailbox,
        host,
    }
}

fn addresses_from_parser(opt: Option<&mail_parser::Address<'_>>) -> Vec<EmailAddress> {
    let Some(a) = opt else { return Vec::new() };
    a.iter().map(addr_from_parser).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConnectStrategy {
    /// Implicit TLS — wrap the socket in TLS immediately.
    Tls,
    /// Cleartext connect, then issue STARTTLS to upgrade.
    Starttls,
}

/// Heuristic: 993 is the universally-assigned implicit-TLS IMAP port.
/// Anything else (143 = stock cleartext IMAP, 1143 = ProtonMail Bridge,
/// 1144 = Bridge alt, etc.) needs STARTTLS.
pub(crate) fn select_connect_strategy(port: u16) -> ConnectStrategy {
    match port {
        993 => ConnectStrategy::Tls,
        _ => ConnectStrategy::Starttls,
    }
}

/// Bridge-style local IMAP relays (ProtonMail Bridge, Hydroxide, etc.)
/// use self-signed certs by default. Trusting localhost is the pragmatic
/// default — MITM there requires local code execution, which already
/// owns the user. Real-host connections still require valid certs.
pub(crate) fn is_local_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

fn build_tls_connector(host: &str) -> Result<native_tls::TlsConnector, ImapError> {
    let mut builder = native_tls::TlsConnector::builder();
    if is_local_host(host) {
        builder
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true);
    }
    builder
        .build()
        .map_err(|e| ImapError::Connect(e.to_string()))
}

pub(crate) fn connect_and_auth(
    host: &str,
    port: u16,
    auth: ImapAuth,
) -> Result<Session<TlsStream<TcpStream>>, ImapError> {
    let tls = build_tls_connector(host)?;
    let client = match select_connect_strategy(port) {
        ConnectStrategy::Tls => imap::connect((host, port), host, &tls)
            .map_err(|e| ImapError::Connect(e.to_string()))?,
        ConnectStrategy::Starttls => imap::connect_starttls((host, port), host, &tls)
            .map_err(|e| ImapError::Connect(e.to_string()))?,
    };
    auth.authenticate(client)
}

pub fn list_senders(
    slot: &Mutex<HandleSlot>,
    host: String,
    port: u16,
    auth: ImapAuth,
    mailbox: String,
    scan_limit: Option<u32>,
) -> Result<Vec<SenderSummary>, ImapError> {
    let total = {
        let mut g = slot.lock().expect("imap state poisoned");
        match g.refresh_mailbox(&host, port, &auth, &mailbox) {
            Ok(m) => m.exists,
            Err(e) => {
                g.invalidate();
                return Err(e);
            }
        }
    };
    if total == 0 {
        return Ok(Vec::new());
    }
    let n = scan_limit.map(|l| l.min(total)).unwrap_or(total);
    let seq_start = total.saturating_sub(n) + 1;
    let range = format!("{seq_start}:*");

    run_with_session(slot, &host, port, &auth, &mailbox, |session| {
        let fetches = session
            .fetch(&range, "(ENVELOPE FLAGS UID)")
            .map_err(|e| ImapError::Fetch(format!("{e}: {e:?}")))?;
        let records = fetches.iter().filter_map(record_from_fetch);
        Ok(aggregate_senders(records))
    })
}

/// Page size for the streaming sender scan. Small enough that the first
/// chunk lands within ~1s on a typical IMAP RTT, large enough that the
/// per-page round-trip overhead doesn't dominate a 500-message scan.
const STREAM_PAGE: u32 = 50;

/// Page size for flag-only refresh. Larger than STREAM_PAGE because
/// `(UID FLAGS)` responses are tiny — we're just diffing seen state.
const FLAG_PAGE: usize = 500;

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn uid_set_string(uids: &[u32]) -> String {
    uids.iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

/// Project an `EmailEnvelope` (which we cache and re-emit) onto an
/// `EnvelopeRecord` (the shape `merge_into` aggregates from). One
/// representation, one source of truth — avoids having two parallel
/// FETCH-to-record mappings drift apart.
fn record_from_envelope(env: &EmailEnvelope) -> Option<EnvelopeRecord> {
    let from = env.from.first()?;
    Some(EnvelopeRecord {
        uid: env.uid,
        from_mailbox: from.mailbox.clone(),
        from_host: from.host.clone(),
        from_name: from.name.clone(),
        subject: env.subject.clone(),
        date: env.date.clone(),
        is_unread: !env.flags.iter().any(|f| f == "\\Seen"),
    })
}

/// Fetch a page of envelopes by sequence range or UID set, retrying
/// once on a fresh session if the first attempt fails. `use_uid_fetch`
/// switches between `FETCH` (sequence numbers) and `UID FETCH`.
fn fetch_envelope_range(
    slot: &Mutex<HandleSlot>,
    host: &str,
    port: u16,
    auth: &ImapAuth,
    mailbox: &str,
    range: &str,
    use_uid_fetch: bool,
) -> Result<Vec<EmailEnvelope>, ImapError> {
    let try_fetch = |session: &mut Session<TlsStream<TcpStream>>| {
        let fetches = if use_uid_fetch {
            session.uid_fetch(range, "(ENVELOPE FLAGS UID)")
        } else {
            session.fetch(range, "(ENVELOPE FLAGS UID)")
        }
        .map_err(|e| ImapError::Fetch(format!("{e}: {e:?}")))?;
        Ok(fetches
            .iter()
            .filter_map(|f| f.uid.map(|u| envelope_from_fetch(u, f)))
            .collect())
    };
    match run_with_session(slot, host, port, auth, mailbox, try_fetch) {
        Ok(v) => Ok(v),
        Err(_) => {
            {
                let mut g = slot.lock().expect("imap state poisoned");
                g.invalidate();
            }
            run_with_session(slot, host, port, auth, mailbox, try_fetch)
        }
    }
}

/// Server's view of new UIDs above `lower_exclusive`. Excludes the
/// boundary value because `UID a:*` is inclusive of `a` per RFC 3501,
/// and on a quiet mailbox the server may echo `a` back.
fn search_new_uids(
    slot: &Mutex<HandleSlot>,
    host: &str,
    port: u16,
    auth: &ImapAuth,
    mailbox: &str,
    lower_exclusive: u32,
) -> Result<Vec<u32>, ImapError> {
    run_with_session(slot, host, port, auth, mailbox, |session| {
        let q = format!("UID {}:*", lower_exclusive.saturating_add(1));
        session
            .uid_search(&q)
            .map(|set| {
                let mut v: Vec<u32> = set
                    .into_iter()
                    .filter(|u| *u > lower_exclusive)
                    .collect();
                v.sort_unstable_by(|a, b| b.cmp(a));
                v
            })
            .map_err(|e| ImapError::Search(format!("{e}: {e:?}")))
    })
}

fn search_all_uids(
    slot: &Mutex<HandleSlot>,
    host: &str,
    port: u16,
    auth: &ImapAuth,
    mailbox: &str,
) -> Result<HashSet<u32>, ImapError> {
    run_with_session(slot, host, port, auth, mailbox, |session| {
        session
            .uid_search("ALL")
            .map(|set| set.into_iter().collect::<HashSet<u32>>())
            .map_err(|e| ImapError::Search(format!("{e}: {e:?}")))
    })
}

/// Fetch FLAGS for the given UIDs in chunks and write any changed sets
/// back to the cache. Returns the count of rows whose unread state
/// changed — caller decides whether to re-emit aggregated senders.
#[allow(clippy::too_many_arguments)]
fn refresh_flags(
    slot: &Mutex<HandleSlot>,
    host: &str,
    port: u16,
    auth: &ImapAuth,
    mailbox: &str,
    uids: &[u32],
    cache: &Cache,
    key: &AccountMailbox,
    prior_unread: &HashMap<u32, bool>,
) -> usize {
    if uids.is_empty() {
        return 0;
    }
    let mut updates: Vec<(u32, Vec<String>)> = Vec::new();
    for chunk in uids.chunks(FLAG_PAGE) {
        let set = uid_set_string(chunk);
        let fetched = run_with_session(slot, host, port, auth, mailbox, |session| {
            session
                .uid_fetch(&set, "(UID FLAGS)")
                .map_err(|e| ImapError::Fetch(format!("{e}: {e:?}")))
        });
        let fetches = match fetched {
            Ok(f) => f,
            Err(e) => {
                eprintln!("imap stream_senders: flag fetch failed: {e}");
                continue;
            }
        };
        for f in fetches.iter() {
            let Some(uid) = f.uid else { continue };
            let new_flags: Vec<String> = f.flags().iter().map(flag_to_string).collect();
            let new_unread = !new_flags.iter().any(|s| s == "\\Seen");
            // Only persist when the unread state flipped — there's
            // nothing user-visible to do for flag changes that don't
            // affect the bubble UI (e.g. \Answered toggling). Skipping
            // those keeps the cache writes proportional to real news.
            match prior_unread.get(&uid) {
                Some(&prev) if prev == new_unread => continue,
                _ => {}
            }
            updates.push((uid, new_flags));
        }
    }
    if updates.is_empty() {
        return 0;
    }
    let n = updates.len();
    if let Err(e) = cache.update_flags(key, &updates) {
        eprintln!("envelope cache: update_flags failed: {e}");
        return 0;
    }
    n
}

#[allow(clippy::too_many_arguments)]
pub fn stream_senders(
    slot: &Mutex<HandleSlot>,
    cache: &Cache,
    host: String,
    port: u16,
    auth: ImapAuth,
    mailbox: String,
    scan_limit: Option<u32>,
    skip_replay: bool,
    on_event: Channel<SenderEvent>,
) -> Result<(), ImapError> {
    let key = AccountMailbox::new(&host, port, auth.username(), &mailbox);

    // ---- Phase 0: cache replay (no IMAP I/O) --------------------------
    // Stream cached senders before the IMAP socket is even opened so the
    // bubbles paint instantly on every launch after the first. When
    // `skip_replay` is set (IDLE-triggered refresh, where the UI already
    // holds the cached state) we still load cached records into the
    // in-memory accumulator so Phase 2's `merge_into` has prior context
    // for display-name and latest-UID resolution — we just don't waste
    // IPC re-sending senders the UI already has.
    let cached_meta = cache.read_meta(&key).ok().flatten();
    let cached_records = cache.list_records(&key).unwrap_or_default();
    let mut effective_uid_set: HashSet<u32> =
        cached_records.iter().map(|r| r.uid).collect();
    let mut effective_max = effective_uid_set.iter().copied().max().unwrap_or(0);

    let mut acc: HashMap<String, SenderSummary> = HashMap::new();
    let had_cache = !cached_records.is_empty();
    if had_cache {
        if skip_replay {
            let _ = merge_into(&mut acc, cached_records.iter().cloned());
        } else {
            let total = cached_records.len() as u32;
            let _ = on_event.send(SenderEvent::Started { total, scan: total });
            const REPLAY_CHUNK: usize = 200;
            for chunk in cached_records.chunks(REPLAY_CHUNK) {
                let delta = merge_into(&mut acc, chunk.iter().cloned());
                if !delta.is_empty() {
                    let _ = on_event.send(SenderEvent::Chunk { senders: delta });
                }
            }
        }
    }
    let prior_unread: HashMap<u32, bool> = cached_records
        .iter()
        .map(|r| (r.uid, r.is_unread))
        .collect();
    drop(cached_records);

    // ---- Phase 1: connect & UIDVALIDITY check -------------------------
    let server_box = {
        let mut g = slot.lock().expect("imap state poisoned");
        match g.refresh_mailbox(&host, port, &auth, &mailbox) {
            Ok(m) => m,
            Err(e) => {
                g.invalidate();
                return Err(e);
            }
        }
    };
    let server_uid_validity = server_box.uid_validity.unwrap_or(0);
    let server_uid_next = server_box.uid_next;
    let server_exists = server_box.exists;

    let validity_changed = cached_meta
        .as_ref()
        .map(|m| m.uid_validity != server_uid_validity)
        .unwrap_or(false);
    if validity_changed {
        // The server rotated UID space — every UID we cached is now
        // ambiguous. Drop everything and treat this as a cold sync.
        if let Err(e) = cache.drop_mailbox(&key) {
            eprintln!("envelope cache: drop_mailbox failed: {e}");
        }
        acc.clear();
        effective_max = 0;
        effective_uid_set.clear();
        let scan = scan_limit
            .map(|l| l.min(server_exists))
            .unwrap_or(server_exists);
        let _ = on_event.send(SenderEvent::Started { total: server_exists, scan });
    } else if !had_cache {
        let scan = scan_limit
            .map(|l| l.min(server_exists))
            .unwrap_or(server_exists);
        let _ = on_event.send(SenderEvent::Started { total: server_exists, scan });
    }

    if server_exists == 0 {
        if !effective_uid_set.is_empty() {
            let uids: Vec<u32> = effective_uid_set.iter().copied().collect();
            if let Err(e) = cache.delete_uids(&key, &uids) {
                eprintln!("envelope cache: delete_uids failed: {e}");
            }
        }
        let _ = cache.write_meta(
            &key,
            &MailboxMeta {
                uid_validity: server_uid_validity,
                uid_next: server_uid_next,
                exists_count: Some(0),
                last_synced_at: now_unix(),
            },
        );
        let _ = on_event.send(SenderEvent::Done);
        return Ok(());
    }

    // ---- Phase 2: delta fetch -----------------------------------------
    if effective_max == 0 {
        // Cold sync: scan a sequence-number window of the newest N
        // messages. Mirrors the original (pre-cache) behaviour exactly,
        // and respects scan_limit so a 50k-message inbox doesn't DoS
        // itself on first launch.
        let n = scan_limit
            .map(|l| l.min(server_exists))
            .unwrap_or(server_exists);
        let seq_start = server_exists.saturating_sub(n) + 1;
        let mut hi = server_exists;
        let mut skipped_pages: u32 = 0;
        loop {
            let lo = hi.saturating_sub(STREAM_PAGE - 1).max(seq_start);
            let range = format!("{lo}:{hi}");
            let envs =
                match fetch_envelope_range(slot, &host, port, &auth, &mailbox, &range, false) {
                    Ok(e) => e,
                    Err(e) => {
                        eprintln!(
                            "imap stream_senders: fetch failed for range {range}, skipping: {e}"
                        );
                        skipped_pages += 1;
                        Vec::new()
                    }
                };
            if !envs.is_empty() {
                if let Err(e) = cache.upsert_envelopes(&key, &envs) {
                    eprintln!("envelope cache: upsert failed: {e}");
                }
                let records: Vec<EnvelopeRecord> =
                    envs.iter().filter_map(record_from_envelope).collect();
                let delta = merge_into(&mut acc, records);
                if !delta.is_empty() {
                    let _ = on_event.send(SenderEvent::Chunk { senders: delta });
                }
            }
            if lo == seq_start {
                break;
            }
            hi = lo - 1;
        }
        if skipped_pages > 0 {
            eprintln!(
                "imap stream_senders: cold sync finished with {skipped_pages} skipped page(s) out of {} total pages",
                n.div_ceil(STREAM_PAGE)
            );
        }
    } else {
        // Warm sync: only fetch new UIDs above what we already cached,
        // detect expunges via UID SEARCH ALL, refresh flags so the
        // unread badges stay correct without re-FETCHing whole envelopes.
        let new_uids =
            search_new_uids(slot, &host, port, &auth, &mailbox, effective_max)
                .unwrap_or_else(|e| {
                    eprintln!("imap stream_senders: new-UID search failed: {e}");
                    Vec::new()
                });
        for chunk in new_uids.chunks(STREAM_PAGE as usize) {
            let set = uid_set_string(chunk);
            let envs = match fetch_envelope_range(
                slot, &host, port, &auth, &mailbox, &set, true,
            ) {
                Ok(e) => e,
                Err(e) => {
                    eprintln!("imap stream_senders: new-UID fetch failed: {e}");
                    Vec::new()
                }
            };
            if !envs.is_empty() {
                if let Err(e) = cache.upsert_envelopes(&key, &envs) {
                    eprintln!("envelope cache: upsert failed: {e}");
                }
                effective_uid_set.extend(envs.iter().map(|e| e.uid));
                let records: Vec<EnvelopeRecord> =
                    envs.iter().filter_map(record_from_envelope).collect();
                let delta = merge_into(&mut acc, records);
                if !delta.is_empty() {
                    let _ = on_event.send(SenderEvent::Chunk { senders: delta });
                }
            }
        }

        let mut needs_resettle = false;

        let server_uids = search_all_uids(slot, &host, port, &auth, &mailbox)
            .unwrap_or_else(|e| {
                eprintln!("imap stream_senders: UID SEARCH ALL failed: {e}");
                HashSet::new()
            });
        if !server_uids.is_empty() {
            let expunged: Vec<u32> = effective_uid_set
                .iter()
                .filter(|u| !server_uids.contains(u))
                .copied()
                .collect();
            if !expunged.is_empty() {
                if let Err(e) = cache.delete_uids(&key, &expunged) {
                    eprintln!("envelope cache: delete_uids failed: {e}");
                }
                for u in &expunged {
                    effective_uid_set.remove(u);
                }
                needs_resettle = true;
            }
        }

        let still_present: Vec<u32> = effective_uid_set.iter().copied().collect();
        let changed = refresh_flags(
            slot,
            &host,
            port,
            &auth,
            &mailbox,
            &still_present,
            cache,
            &key,
            &prior_unread,
        );
        if changed > 0 {
            needs_resettle = true;
        }

        // After warm sync we rebuild the full sender list from the
        // current cache and emit it as one chunk. The frontend's
        // `mergeSenders` keys by sender so updated counts replace
        // stale ones for any (mailbox,host) we still know about.
        // Known limitation: a sender whose every message was expunged
        // can't be removed by the frontend through this channel — its
        // bubble lingers as a zero-count ghost until full reload.
        if needs_resettle {
            let fresh = cache.list_records(&key).unwrap_or_default();
            let mut new_acc: HashMap<String, SenderSummary> = HashMap::new();
            let _ = merge_into(&mut new_acc, fresh);
            let senders: Vec<SenderSummary> = new_acc.into_values().collect();
            if !senders.is_empty() {
                let _ = on_event.send(SenderEvent::Chunk { senders });
            }
        }
    }

    if let Err(e) = cache.write_meta(
        &key,
        &MailboxMeta {
            uid_validity: server_uid_validity,
            uid_next: server_uid_next,
            exists_count: Some(server_exists),
            last_synced_at: now_unix(),
        },
    ) {
        eprintln!("envelope cache: write_meta failed: {e}");
    }

    let _ = on_event.send(SenderEvent::Done);
    Ok(())
}

pub fn fetch_from_sender(
    slot: &Mutex<HandleSlot>,
    host: String,
    port: u16,
    auth: ImapAuth,
    mailbox: String,
    from_address: String,
    limit: Option<u32>,
) -> Result<Vec<EmailEnvelope>, ImapError> {
    // Try server-side SEARCH first; fall back to a client-side scan if the
    // server's SEARCH response fails to parse (e.g. ProtonMail Bridge).
    let search_outcome = run_with_session(slot, &host, port, &auth, &mailbox, |session| {
        let query = format!("FROM {}", imap_quoted(&from_address));
        match session.uid_search(&query) {
            Ok(set) => Ok(SearchOutcome::Uids(set.into_iter().collect())),
            Err(imap::Error::Parse(pe)) => {
                eprintln!("uid_search parse error, falling back to client-side filter: {pe:?}");
                Ok(SearchOutcome::FallbackNeeded)
            }
            Err(e) => Err(ImapError::Search(format!("{e}: {e:?}"))),
        }
    })?;

    let mut uids: Vec<u32> = match search_outcome {
        SearchOutcome::Uids(u) => u,
        SearchOutcome::FallbackNeeded => {
            let total = {
                let mut g = slot.lock().expect("imap state poisoned");
                match g.refresh_mailbox(&host, port, &auth, &mailbox) {
                    Ok(m) => m.exists,
                    Err(e) => {
                        g.invalidate();
                        return Err(e);
                    }
                }
            };
            return run_with_session(slot, &host, port, &auth, &mailbox, |session| {
                fallback_client_side_filter(session, total, &from_address, limit)
            });
        }
    };

    if uids.is_empty() {
        return Ok(Vec::new());
    }

    uids.sort_unstable_by(|a, b| b.cmp(a));
    if let Some(n) = limit {
        uids.truncate(n as usize);
    }

    fetch_envelopes_by_uids(slot, host, port, auth, mailbox, uids)
}

enum SearchOutcome {
    Uids(Vec<u32>),
    FallbackNeeded,
}

pub fn fetch_envelopes_by_uids(
    slot: &Mutex<HandleSlot>,
    host: String,
    port: u16,
    auth: ImapAuth,
    mailbox: String,
    uids: Vec<u32>,
) -> Result<Vec<EmailEnvelope>, ImapError> {
    if uids.is_empty() {
        return Ok(Vec::new());
    }

    let uid_set = uids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");

    run_with_session(slot, &host, port, &auth, &mailbox, |session| {
        let fetches = session
            .uid_fetch(&uid_set, "(ENVELOPE FLAGS UID)")
            .map_err(|e| ImapError::Fetch(format!("{e}: {e:?}")))?;

        let by_uid: HashMap<u32, &Fetch> = fetches
            .iter()
            .filter_map(|f| f.uid.map(|u| (u, f)))
            .collect();

        Ok(uids
            .iter()
            .filter_map(|u| by_uid.get(u).map(|f| envelope_from_fetch(*u, f)))
            .collect())
    })
}

/// Lower-cased `mailbox@host` extracted from an envelope's first From
/// address — the comparison key for `envelope_matches_from`.
pub(crate) fn envelope_from_key(env: &EmailEnvelope) -> Option<String> {
    let addr = env.from.first()?;
    let m = addr.mailbox.as_deref().unwrap_or("").to_lowercase();
    let h = addr.host.as_deref().unwrap_or("").to_lowercase();
    if m.is_empty() || h.is_empty() {
        return None;
    }
    Some(format!("{m}@{h}"))
}

pub(crate) fn envelope_matches_from(env: &EmailEnvelope, target_lower: &str) -> bool {
    envelope_from_key(env)
        .map(|k| k == target_lower)
        .unwrap_or(false)
}

fn fallback_client_side_filter(
    session: &mut Session<TlsStream<TcpStream>>,
    total: u32,
    from_address: &str,
    limit: Option<u32>,
) -> Result<Vec<EmailEnvelope>, ImapError> {
    if total == 0 {
        return Ok(Vec::new());
    }
    // Cap how much we scan; large mailboxes would be slow otherwise.
    // 5000 envelopes is plenty for a Bridge-typical use case.
    let scan = limit.unwrap_or(100).clamp(100, 5000).min(total);
    let seq_start = total - scan + 1;
    let range = format!("{seq_start}:*");

    let fetches = session
        .fetch(&range, "(ENVELOPE FLAGS UID)")
        .map_err(|e| ImapError::Fetch(format!("{e}: {e:?}")))?;

    let target = from_address.to_lowercase();
    let mut envelopes: Vec<EmailEnvelope> = fetches
        .iter()
        .filter_map(|f| f.uid.map(|u| envelope_from_fetch(u, f)))
        .filter(|env| envelope_matches_from(env, &target))
        .collect();

    envelopes.sort_by_key(|e| std::cmp::Reverse(e.uid));
    if let Some(n) = limit {
        envelopes.truncate(n as usize);
    }
    Ok(envelopes)
}

pub fn fetch_body(
    slot: &Mutex<HandleSlot>,
    cache: &Cache,
    host: String,
    port: u16,
    auth: ImapAuth,
    mailbox: String,
    uid: u32,
) -> Result<EmailBody, ImapError> {
    let key = AccountMailbox::new(&host, port, auth.username(), &mailbox);

    let (body, server_flags) = run_with_session(slot, &host, port, &auth, &mailbox, |session| {
        // BODY[] (without .PEEK) atomically sets the \Seen flag on the
        // server as part of the same round trip — that's the standard
        // "open mail = mark read" behaviour every regular mail client
        // does. Asking for FLAGS in the same FETCH gets us the server's
        // post-mutation flag set in one round trip, which we then write
        // through to the cache so the next launch's Phase 0 replay
        // doesn't show this message as unread.
        let fetches = session
            .uid_fetch(uid.to_string(), "(BODY[] UID FLAGS)")
            .map_err(|e| ImapError::Fetch(format!("{e}: {e:?}")))?;
        let f = fetches.iter().next().ok_or(ImapError::NotFound(uid))?;
        let raw = f
            .body()
            .ok_or_else(|| ImapError::Fetch("no body part returned".into()))?;
        let flags: Vec<String> = f.flags().iter().map(flag_to_string).collect();
        Ok((build_email_body(uid, raw)?, flags))
    })?;

    // Best-effort cache write — a cache failure must not abort the
    // user-facing body fetch. Logged so a persistent issue is visible.
    if let Err(e) = cache.update_flags(&key, &[(uid, server_flags)]) {
        eprintln!("envelope cache: update_flags after fetch_body failed: {e}");
    }

    Ok(body)
}

pub(crate) fn build_email_body(uid: u32, raw: &[u8]) -> Result<EmailBody, ImapError> {
    let msg = mail_parser::MessageParser::default()
        .parse(raw)
        .ok_or_else(|| ImapError::Parse("mail-parser returned None".into()))?;

    let mut attachments: Vec<AttachmentInfo> = Vec::new();
    let mut inline_parts: Vec<InlinePart> = Vec::new();
    let mut inline_total_bytes: usize = 0;

    for p in msg.attachments() {
        let content_type = part_content_type(p);

        // Anything carrying a Content-ID is potentially referenceable from
        // the HTML body via `cid:`. We split those out and ship the bytes
        // (base64) so the renderer can rewrite to `data:` URLs at sanitize
        // time. Parts without a Content-ID are user-facing attachments
        // listed under the body — metadata-only for now (download lives
        // in a separate task).
        if let Some(cid) = p.content_id() {
            let bytes = p.contents();
            if inline_total_bytes.saturating_add(bytes.len()) > INLINE_PARTS_TOTAL_CAP_BYTES {
                continue;
            }
            inline_total_bytes += bytes.len();
            inline_parts.push(InlinePart {
                content_id: strip_cid_brackets(cid).to_owned(),
                content_type,
                data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            });
        } else {
            attachments.push(AttachmentInfo {
                filename: p.attachment_name().map(str::to_owned),
                content_type,
                size: p.contents().len() as u32,
            });
        }
    }

    Ok(EmailBody {
        uid,
        subject: msg.subject().map(str::to_owned),
        from: addresses_from_parser(msg.from()),
        to: addresses_from_parser(msg.to()),
        cc: addresses_from_parser(msg.cc()),
        date: msg.date().map(|d| d.to_rfc822()),
        text_body: msg.body_text(0).map(|c| c.into_owned()),
        html_body: msg.body_html(0).map(|c| c.into_owned()),
        attachments,
        inline_parts,
    })
}

fn part_content_type(p: &mail_parser::MessagePart<'_>) -> String {
    p.content_type()
        .map(|ct| {
            let sub = ct.subtype().unwrap_or("octet-stream");
            format!("{}/{}", ct.ctype(), sub)
        })
        .unwrap_or_else(|| "application/octet-stream".into())
}

/// Content-ID values arrive as `<abc@host>` per RFC 2392; HTML references
/// strip the brackets (`cid:abc@host`). We normalise to the bracket-less
/// form so the frontend's cid→data lookup can match by exact equality.
fn strip_cid_brackets(cid: &str) -> &str {
    let s = cid.trim();
    s.strip_prefix('<')
        .and_then(|t| t.strip_suffix('>'))
        .unwrap_or(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(
        uid: u32,
        mailbox: &str,
        host: &str,
        name: Option<&str>,
        subject: Option<&str>,
    ) -> EnvelopeRecord {
        EnvelopeRecord {
            uid,
            from_mailbox: Some(mailbox.into()),
            from_host: Some(host.into()),
            from_name: name.map(Into::into),
            subject: subject.map(Into::into),
            date: None,
            is_unread: false,
        }
    }

    fn rec_unread(uid: u32, mailbox: &str, host: &str) -> EnvelopeRecord {
        EnvelopeRecord {
            uid,
            from_mailbox: Some(mailbox.into()),
            from_host: Some(host.into()),
            from_name: None,
            subject: None,
            date: None,
            is_unread: true,
        }
    }

    #[test]
    fn decode_header_text_decodes_q_and_b_encoded_words() {
        assert_eq!(
            decode_header_text("=?utf-8?q?Keep_the_adventure_rolling=F0=9F=8C=8D?=".into()),
            "Keep the adventure rolling🌍",
        );
        assert_eq!(
            decode_header_text("=?utf-8?B?SGVsbG8sIHdvcmxkIQ==?=".into()),
            "Hello, world!",
        );
    }

    #[test]
    fn decode_header_text_passes_plain_ascii_through_unchanged() {
        assert_eq!(decode_header_text("Done with winter?".into()), "Done with winter?");
        assert_eq!(decode_header_text("".into()), "");
    }

    #[test]
    fn imap_quoted_wraps_and_escapes_control_chars() {
        assert_eq!(imap_quoted("simple@example.com"), "\"simple@example.com\"");
        assert_eq!(imap_quoted("a\"b"), "\"a\\\"b\"");
        assert_eq!(imap_quoted("a\\b"), "\"a\\\\b\"");
        assert_eq!(imap_quoted(""), "\"\"");
    }

    #[test]
    fn merge_into_records_uids_newest_first_across_chunks() {
        let mut acc: HashMap<String, SenderSummary> = HashMap::new();

        // First chunk: oldest two messages.
        let _ = merge_into(
            &mut acc,
            vec![
                rec(10, "a", "b.com", None, None),
                rec(12, "a", "b.com", None, None),
            ],
        );
        let s = acc.get("b.com").unwrap();
        assert_eq!(s.uids, vec![12, 10]);

        // Second chunk: a newer one and an even older one — interleave correctly.
        let _ = merge_into(
            &mut acc,
            vec![
                rec(20, "a", "b.com", None, None),
                rec(5, "a", "b.com", None, None),
            ],
        );
        let s = acc.get("b.com").unwrap();
        assert_eq!(s.uids, vec![20, 12, 10, 5]);
        assert_eq!(s.message_count, 4);
        assert_eq!(s.latest_uid, 20);
    }

    #[test]
    fn merge_into_counts_unread_records_only() {
        let mut acc: HashMap<String, SenderSummary> = HashMap::new();
        let _ = merge_into(
            &mut acc,
            vec![
                rec(1, "a", "b.com", None, None),       // read
                rec_unread(2, "a", "b.com"),
                rec_unread(3, "a", "b.com"),
                rec(4, "a", "b.com", None, None),       // read
            ],
        );
        let s = acc.get("b.com").unwrap();
        assert_eq!(s.message_count, 4);
        assert_eq!(s.unread_count, 2);
    }

    #[test]
    fn aggregate_groups_case_insensitively() {
        let recs = vec![
            rec(1, "Ada", "Example.com", Some("Ada L."), Some("hi")),
            rec(2, "ada", "example.com", Some("Ada"), Some("hello")),
        ];
        let out = aggregate_senders(recs);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].message_count, 2);
        // example.com is a non-consumer host → domain-grouped, mailbox dropped.
        assert!(out[0].address.mailbox.is_none());
        assert_eq!(out[0].address.host.as_deref(), Some("example.com"));
    }

    #[test]
    fn aggregate_picks_latest_uid_subject_date_and_name() {
        let recs = vec![
            EnvelopeRecord {
                uid: 5,
                from_mailbox: Some("a".into()),
                from_host: Some("b.com".into()),
                from_name: Some("Older".into()),
                subject: Some("old".into()),
                date: Some("Mon, 01 Jan 2024 00:00:00 +0000".into()),
                is_unread: false,
            },
            EnvelopeRecord {
                uid: 10,
                from_mailbox: Some("a".into()),
                from_host: Some("b.com".into()),
                from_name: Some("Newer".into()),
                subject: Some("new".into()),
                date: Some("Tue, 02 Jan 2024 00:00:00 +0000".into()),
                is_unread: false,
            },
        ];
        let out = aggregate_senders(recs);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].latest_uid, 10);
        assert_eq!(out[0].latest_subject.as_deref(), Some("new"));
        assert_eq!(out[0].display_name.as_deref(), Some("Newer"));
    }

    #[test]
    fn aggregate_keeps_existing_display_name_when_newer_record_has_none() {
        let recs = vec![
            rec(1, "a", "b.com", Some("Real Name"), None),
            rec(2, "a", "b.com", None, None),
        ];
        let out = aggregate_senders(recs);
        assert_eq!(out[0].display_name.as_deref(), Some("Real Name"));
        assert_eq!(out[0].latest_uid, 2);
    }

    #[test]
    fn aggregate_drops_records_missing_mailbox_or_host() {
        let recs = vec![
            rec(1, "", "b.com", None, None),
            rec(2, "a", "", None, None),
            rec(3, "a", "b.com", None, None),
        ];
        let out = aggregate_senders(recs);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].message_count, 1);
    }

    #[test]
    fn aggregate_sorts_descending_by_latest_uid() {
        // Three distinct brand hosts so domain-grouping doesn't fold
        // them into one entry; we're verifying sort by latest_uid.
        let recs = vec![
            rec(5, "x", "older.com", None, None),
            rec(99, "x", "newer.com", None, None),
            rec(50, "x", "middle.com", None, None),
        ];
        let out = aggregate_senders(recs);
        assert_eq!(out[0].address.host.as_deref(), Some("newer.com"));
        assert_eq!(out[1].address.host.as_deref(), Some("middle.com"));
        assert_eq!(out[2].address.host.as_deref(), Some("older.com"));
    }

    #[test]
    fn is_consumer_domain_recognises_known_providers() {
        assert!(is_consumer_domain("gmail.com"));
        assert!(is_consumer_domain("googlemail.com"));
        assert!(is_consumer_domain("icloud.com"));
        assert!(is_consumer_domain("proton.me"));
        assert!(is_consumer_domain("GMAIL.COM"));
        assert!(is_consumer_domain("  gmail.com  "));

        assert!(!is_consumer_domain("vercel.com"));
        assert!(!is_consumer_domain("cnn.com"));
        // Subdomains of consumer providers stay consumer (so a stray
        // `m.gmail.com` correspondent doesn't get domain-aggregated).
        assert!(is_consumer_domain("mail.gmail.com"));
        assert!(!is_consumer_domain("email.brand.com"));
        assert!(!is_consumer_domain(""));
    }

    #[test]
    fn merge_into_groups_brand_records_by_host_only() {
        let mut acc: HashMap<String, SenderSummary> = HashMap::new();
        let _ = merge_into(
            &mut acc,
            vec![
                rec(10, "noreply", "vercel.com", Some("Vercel"), Some("welcome")),
                rec(20, "support", "vercel.com", Some("Vercel Support"), Some("re: ticket")),
                rec(15, "welcome", "vercel.com", None, Some("hi")),
            ],
        );
        assert_eq!(acc.len(), 1);
        let s = acc.get("vercel.com").expect("domain-keyed entry");
        assert!(s.address.mailbox.is_none());
        assert_eq!(s.address.host.as_deref(), Some("vercel.com"));
        assert_eq!(s.message_count, 3);
        assert_eq!(s.uids, vec![20, 15, 10]);
        // display_name follows the latest UID across all mailboxes.
        assert_eq!(s.display_name.as_deref(), Some("Vercel Support"));
        assert_eq!(s.latest_uid, 20);
        assert_eq!(s.hosts, vec!["vercel.com".to_string()]);
    }

    #[test]
    fn registrable_domain_strips_subdomains_via_psl() {
        // Plain eTLD+1 → unchanged.
        assert_eq!(registrable_domain("linear.app"), "linear.app");
        assert_eq!(registrable_domain("netflix.com"), "netflix.com");
        // Subdomains collapse.
        assert_eq!(registrable_domain("updates.linear.app"), "linear.app");
        assert_eq!(registrable_domain("members.netflix.com"), "netflix.com");
        assert_eq!(registrable_domain("a.b.c.example.com"), "example.com");
        // Multi-part TLDs handled correctly by the PSL.
        assert_eq!(registrable_domain("foo.bbc.co.uk"), "bbc.co.uk");
        // Case-insensitive input → lowercased output.
        assert_eq!(registrable_domain("Updates.Linear.APP"), "linear.app");
        // Unrecognised hosts fall back unchanged (lowercased).
        assert_eq!(registrable_domain("localhost"), "localhost");
        assert_eq!(registrable_domain("127.0.0.1"), "127.0.0.1");
    }

    #[test]
    fn merge_into_collapses_subdomains_to_registrable_domain() {
        let mut acc: HashMap<String, SenderSummary> = HashMap::new();
        let _ = merge_into(
            &mut acc,
            vec![
                rec(10, "noreply", "linear.app", Some("Linear"), Some("welcome")),
                rec(20, "alerts", "updates.linear.app", Some("Linear Updates"), Some("digest")),
                rec(15, "team", "linear.app", None, Some("hi")),
            ],
        );
        assert_eq!(acc.len(), 1);
        let s = acc.get("linear.app").expect("registrable-domain key");
        assert!(s.address.mailbox.is_none());
        assert_eq!(s.address.host.as_deref(), Some("linear.app"));
        assert_eq!(s.message_count, 3);
        assert_eq!(s.uids, vec![20, 15, 10]);
        assert_eq!(s.display_name.as_deref(), Some("Linear Updates"));
        // Both the apex and the subdomain are retained as BIMI-lookup
        // candidates so the frontend can fall back when the apex misses.
        assert_eq!(
            s.hosts,
            vec!["linear.app".to_string(), "updates.linear.app".to_string()],
        );
    }

    #[test]
    fn is_consumer_domain_treats_subdomains_of_known_providers_as_consumer() {
        assert!(is_consumer_domain("m.gmail.com"));
        assert!(is_consumer_domain("mail.proton.me"));
        // Brand subdomains stay non-consumer.
        assert!(!is_consumer_domain("updates.linear.app"));
        assert!(!is_consumer_domain("members.netflix.com"));
    }

    #[test]
    fn merge_into_keeps_consumer_records_per_mailbox() {
        let mut acc: HashMap<String, SenderSummary> = HashMap::new();
        let _ = merge_into(
            &mut acc,
            vec![
                rec(10, "alice", "gmail.com", Some("Alice"), None),
                rec(11, "bob", "gmail.com", Some("Bob"), None),
                rec(12, "alice", "gmail.com", Some("Alice"), None),
            ],
        );
        assert_eq!(acc.len(), 2);
        let alice = acc.get("alice@gmail.com").expect("alice keyed per-mailbox");
        assert_eq!(alice.address.mailbox.as_deref(), Some("alice"));
        assert_eq!(alice.address.host.as_deref(), Some("gmail.com"));
        assert_eq!(alice.message_count, 2);
        assert_eq!(alice.uids, vec![12, 10]);
        assert_eq!(alice.hosts, vec!["gmail.com".to_string()]);
        let bob = acc.get("bob@gmail.com").expect("bob keyed per-mailbox");
        assert_eq!(bob.message_count, 1);
        assert_eq!(bob.address.mailbox.as_deref(), Some("bob"));
        assert_eq!(bob.hosts, vec!["gmail.com".to_string()]);
    }

    #[test]
    fn split_email_separates_at_last_at_sign() {
        assert_eq!(
            split_email("ada@example.com"),
            (Some("ada".into()), Some("example.com".into()))
        );
        assert_eq!(
            split_email("first+tag@sub.example.com"),
            (
                Some("first+tag".into()),
                Some("sub.example.com".into())
            )
        );
        assert_eq!(split_email(""), (None, None));
        assert_eq!(split_email("nohost"), (Some("nohost".into()), None));
    }

    #[test]
    fn select_connect_strategy_uses_implicit_tls_only_for_993() {
        assert_eq!(select_connect_strategy(993), ConnectStrategy::Tls);
        assert_eq!(select_connect_strategy(143), ConnectStrategy::Starttls);
        assert_eq!(select_connect_strategy(1143), ConnectStrategy::Starttls);
        assert_eq!(select_connect_strategy(1144), ConnectStrategy::Starttls);
        assert_eq!(select_connect_strategy(2143), ConnectStrategy::Starttls);
    }

    #[test]
    fn is_local_host_recognises_loopback_names_only() {
        assert!(is_local_host("localhost"));
        assert!(is_local_host("127.0.0.1"));
        assert!(is_local_host("::1"));
        assert!(!is_local_host("example.com"));
        assert!(!is_local_host("imap.fastmail.com"));
        assert!(!is_local_host("192.168.1.1"));
    }

    #[test]
    fn flag_to_string_uses_backslash_prefixed_keywords() {
        assert_eq!(flag_to_string(&Flag::Seen), "\\Seen");
        assert_eq!(flag_to_string(&Flag::Answered), "\\Answered");
        assert_eq!(
            flag_to_string(&Flag::Custom("$Important".into())),
            "$Important"
        );
    }

    fn env_with_from(uid: u32, mailbox: &str, host: &str) -> EmailEnvelope {
        EmailEnvelope {
            uid,
            subject: None,
            from: vec![EmailAddress {
                name: None,
                mailbox: Some(mailbox.into()),
                host: Some(host.into()),
            }],
            to: vec![],
            cc: vec![],
            date: None,
            message_id: None,
            in_reply_to: None,
            flags: vec![],
        }
    }

    #[test]
    fn envelope_from_key_is_lowercase_mailbox_at_host() {
        let e = env_with_from(1, "Ada", "Example.COM");
        assert_eq!(envelope_from_key(&e).as_deref(), Some("ada@example.com"));
    }

    #[test]
    fn envelope_from_key_returns_none_when_either_part_empty() {
        let mut e = env_with_from(1, "ada", "");
        assert!(envelope_from_key(&e).is_none());
        e = env_with_from(1, "", "example.com");
        assert!(envelope_from_key(&e).is_none());
    }

    #[test]
    fn envelope_from_key_returns_none_when_from_list_empty() {
        let e = EmailEnvelope {
            uid: 1,
            subject: None,
            from: vec![],
            to: vec![],
            cc: vec![],
            date: None,
            message_id: None,
            in_reply_to: None,
            flags: vec![],
        };
        assert!(envelope_from_key(&e).is_none());
    }

    #[test]
    fn envelope_matches_from_compares_case_insensitively_against_lowercase_target() {
        let e = env_with_from(1, "Ada", "Example.com");
        assert!(envelope_matches_from(&e, "ada@example.com"));
        assert!(!envelope_matches_from(&e, "bob@example.com"));
    }

    #[test]
    fn build_email_body_parses_minimal_text_message() {
        let raw = b"From: Ada <ada@example.com>\r\n\
            To: Bob <bob@example.com>\r\n\
            Subject: Hello\r\n\
            Date: Mon, 01 Jan 2024 12:00:00 +0000\r\n\
            Content-Type: text/plain; charset=utf-8\r\n\
            \r\n\
            This is the body.\r\n";
        let body = build_email_body(42, raw).expect("parse");
        assert_eq!(body.uid, 42);
        assert_eq!(body.subject.as_deref(), Some("Hello"));
        assert_eq!(body.from.len(), 1);
        assert_eq!(body.from[0].mailbox.as_deref(), Some("ada"));
        assert_eq!(body.from[0].host.as_deref(), Some("example.com"));
        assert_eq!(body.from[0].name.as_deref(), Some("Ada"));
        assert_eq!(body.to.len(), 1);
        assert!(body
            .text_body
            .as_deref()
            .unwrap_or("")
            .contains("This is the body."));
        assert!(body.attachments.is_empty());
    }

    #[test]
    fn build_email_body_extracts_attachment_metadata() {
        let raw = b"From: a@b.com\r\n\
            To: c@d.com\r\n\
            Subject: with attach\r\n\
            MIME-Version: 1.0\r\n\
            Content-Type: multipart/mixed; boundary=\"BOUND\"\r\n\
            \r\n\
            --BOUND\r\n\
            Content-Type: text/plain\r\n\
            \r\n\
            hi\r\n\
            --BOUND\r\n\
            Content-Type: text/plain; name=\"note.txt\"\r\n\
            Content-Disposition: attachment; filename=\"note.txt\"\r\n\
            \r\n\
            attached\r\n\
            --BOUND--\r\n";
        let body = build_email_body(1, raw).expect("parse");
        assert_eq!(body.attachments.len(), 1);
        assert_eq!(body.attachments[0].filename.as_deref(), Some("note.txt"));
        assert!(body.attachments[0].content_type.starts_with("text/plain"));
        assert!(body.attachments[0].size > 0);
        assert!(body.inline_parts.is_empty());
    }

    #[test]
    fn build_email_body_extracts_inline_parts_with_stripped_cid() {
        // Tiny 1×1 PNG; sufficient bytes to round-trip through base64.
        let png_bytes: &[u8] = b"\x89PNG\r\n\x1a\nFAKEPNG";
        let png_b64 = base64::engine::general_purpose::STANDARD.encode(png_bytes);

        // multipart/related with HTML referencing cid:logo and a matching
        // image part carrying `Content-ID: <logo@host>` (angle brackets per
        // RFC 2392 — the renderer strips them so cid:logo resolves).
        let raw = format!(
            "From: a@b.com\r\n\
             To: c@d.com\r\n\
             Subject: inline image\r\n\
             MIME-Version: 1.0\r\n\
             Content-Type: multipart/related; boundary=\"BOUND\"\r\n\
             \r\n\
             --BOUND\r\n\
             Content-Type: text/html; charset=utf-8\r\n\
             \r\n\
             <p><img src=\"cid:logo@host\"></p>\r\n\
             --BOUND\r\n\
             Content-Type: image/png\r\n\
             Content-ID: <logo@host>\r\n\
             Content-Transfer-Encoding: base64\r\n\
             Content-Disposition: inline\r\n\
             \r\n\
             {png_b64}\r\n\
             --BOUND--\r\n",
        );
        let body = build_email_body(7, raw.as_bytes()).expect("parse");

        assert!(body.html_body.is_some(), "html body should parse");
        assert!(
            body.attachments.is_empty(),
            "inline part must not appear in attachments"
        );
        assert_eq!(body.inline_parts.len(), 1, "inline part must be extracted");
        let part = &body.inline_parts[0];
        assert_eq!(part.content_id, "logo@host", "cid brackets must be stripped");
        assert_eq!(part.content_type, "image/png");
        assert_eq!(part.data_base64, png_b64, "bytes round-trip via base64");
    }
}
