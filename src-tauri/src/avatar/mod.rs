//! Avatar resolution for sender bubbles.
//!
//! Strategy: BIMI is the first-priority source — a domain with a published
//! BIMI record gives us a vector logo we can render at any size. If a
//! domain has no BIMI record, the frontend falls back to a Gravatar URL
//! (which itself uses Gravatar's identicon fallback for unknown emails),
//! so this module's job is just "does this domain have a BIMI logo, and
//! if so, what is it?".
//!
//! Both the positive and negative answers are cached on disk so a
//! restart doesn't re-pay the DNS + HTTPS round trip. Cache TTLs are:
//! found = 7 days, missing = 24 hours.

mod bimi;
mod cache;

pub use cache::CacheState;

use serde::Serialize;

// `rename_all` on an enum renames variant names; the fields inside each
// variant are unaffected. `rename_all_fields` is the one that descends
// into variant structs — without it the IPC payload uses `svg_data_url`
// while the TypeScript reader expects `svgDataUrl`, the field comes
// back undefined, and the bubble paints with no background. Don't drop
// `rename_all_fields` without rechecking the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "status")]
pub enum BimiResolution {
    Found { svg_data_url: String },
    Missing,
}

/// Look up a domain's BIMI logo, hitting the disk cache first. Domains
/// are normalised to lowercase before any work happens so case-variant
/// keys can't double-pay.
pub async fn resolve(state: &CacheState, domain: &str) -> BimiResolution {
    let domain = domain.trim().to_ascii_lowercase();
    if domain.is_empty() {
        return BimiResolution::Missing;
    }

    if let Some(hit) = state.get_fresh(&domain) {
        return hit;
    }

    let resolved = match bimi::lookup(&domain).await {
        Ok(Some(svg_bytes)) => {
            let data_url = bimi::svg_data_url(&svg_bytes);
            BimiResolution::Found {
                svg_data_url: data_url,
            }
        }
        Ok(None) | Err(_) => BimiResolution::Missing,
    };

    state.put(&domain, &resolved);
    resolved
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lock down the IPC payload shape the frontend reads. Both the
    /// `status` discriminator and the `svgDataUrl` field are
    /// camelCase — if either reverts to snake_case the TS reader
    /// silently gets `undefined` and bubbles paint with no logo.
    #[test]
    fn found_serialises_with_camel_case_status_and_field() {
        let r = BimiResolution::Found {
            svg_data_url: "data:image/svg+xml;base64,PHN2Zy8+".into(),
        };
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["status"], "found");
        assert_eq!(json["svgDataUrl"], "data:image/svg+xml;base64,PHN2Zy8+");
        assert!(json.get("svg_data_url").is_none());
    }

    #[test]
    fn missing_serialises_as_status_only() {
        let r = BimiResolution::Missing;
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["status"], "missing");
    }
}
