//! QDEF mandatory core: magic framing, CBOR-Sequence-of-Records walking,
//! typeID-prefix routing (§3.1), the even/odd criticality rule
//! (docs/QDEF-SPEC.md §2–§3.3). No knowledge of any specific Record
//! Type, no compression, no reassembly — those live in a separate
//! standard-record-type layer, not here, by design.
//!
//! Every Record is a sequence of CBOR items terminating in a CBOR Map:
//! one or more typeID items (uint or byte string) followed by zero or
//! more unknown items (forward-compat padding), then the field Map as
//! the record delimiter. The parser accumulates typeIDs in a contiguous
//! run at the start, skips unknown items, and stops at the first Map.
//!
//! No version byte: the container is magic + a CBOR Sequence of Records,
//! full stop. Container-level metadata (a format namespace) lives inside
//! the Sequence itself, as a Record with the reserved Type ID 0 (see
//! header.js in the Node prototype) — an ordinary Record, not a distinct
//! wire structure. The mandatory core has no per-Type schema knowledge at
//! all; Type 0 is routed and walked by the exact same machinery as any
//! other Record.
//!
//! `no_std`, zero heap allocation, zero dependencies, and — thanks to
//! §3.2's field-value-shape rule (Record field values are always a scalar
//! or a definite-length string, never a bare array/map/tag) — the
//! field-value skip is entirely recursion-free. Skipping unknown prefix
//! items uses a bounded explicit stack (also zero allocation). See
//! `cbor::skip_value`, `cbor::skip_any_item`, and ../../docs/FINDINGS.md.
#![cfg_attr(not(test), no_std)]

mod cbor;

pub const MAGIC: [u8; 4] = *b"QDEF";

/// Maximum number of typeIDs accumulated per Record.
const MAX_TYPE_IDS: usize = 4;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Error {
    TooShortForHeader,
    BadMagic,
    Cbor(cbor::Error),
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum CriticalityOutcome {
    Ok,
    /// §3.2: an unrecognized even key aborted this record. Carries the key.
    Aborted(u64),
}

enum ControlFlow {
    Continue,
    Stop,
}

/// A parsed QDEF container: valid magic, wrapping the CBOR Sequence of
/// Records that follows.
pub struct Container<'a> {
    seq: &'a [u8],
}

impl<'a> Container<'a> {
    pub fn parse(buf: &'a [u8]) -> Result<Self, Error> {
        if buf.len() < 4 {
            return Err(Error::TooShortForHeader);
        }
        if buf[0..4] != MAGIC {
            return Err(Error::BadMagic);
        }
        Ok(Container { seq: &buf[4..] })
    }

    pub fn records(&self) -> Records<'a> {
        Records {
            remaining: self.seq,
            done: false,
        }
    }
}

/// The NDEF path (§2): a bare CBOR Sequence with no magic prefix,
/// because NDEF's own MIME type (`application/vnd.qdef`) already identifies
/// the payload. Routes through the identical Record-parsing logic.
pub fn records_from_sequence(seq: &[u8]) -> Records<'_> {
    Records {
        remaining: seq,
        done: false,
    }
}

pub struct Records<'a> {
    remaining: &'a [u8],
    done: bool,
}

impl<'a> Iterator for Records<'a> {
    type Item = Result<Record<'a>, Error>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.done || self.remaining.is_empty() {
            return None;
        }
        match parse_record(self.remaining) {
            Ok((record, consumed)) => {
                self.remaining = &self.remaining[consumed..];
                Some(Ok(record))
            }
            Err(e) => {
                // A malformed CBOR item means we can no longer determine
                // where it ends, so we can't safely resume the Sequence —
                // unlike a well-formed Record with no typeIDs (ignored),
                // which skips only itself.
                self.done = true;
                Some(Err(e))
            }
        }
    }
}

/// A routed Record: which Type IDs it claims (via the prefix items,
/// §3.1's routing mechanism), and its raw map bytes for a
/// Record-Type-specific handler (e.g. `check_criticality`,
/// `find_value`) to inspect further.
pub struct Record<'a> {
    /// The accumulated typeID keys from the record prefix (up to
    /// `MAX_TYPE_IDS`; extras are silently dropped).
    type_ids_buf: [cbor::Key<'a>; MAX_TYPE_IDS],
    /// Number of valid entries in `type_ids_buf`.
    type_id_count: usize,
    /// True if no typeID was found before the map — the record is
    /// unroutable and should be ignored by dispatch logic.
    pub ignored: bool,
    /// The field map bytes (from the map delimiter to the end of the
    /// map). Empty slice if no map was found (incomplete record).
    pub map_bytes: &'a [u8],
}

impl<'a> Record<'a> {
    /// The first typeID, if any. This is the primary routing key.
    pub fn type_id(&self) -> Option<cbor::Key<'a>> {
        if self.type_id_count > 0 {
            Some(self.type_ids_buf[0])
        } else {
            None
        }
    }

    /// All accumulated typeIDs (primary + backup).
    pub fn type_ids(&self) -> &[cbor::Key<'a>] {
        &self.type_ids_buf[..self.type_id_count]
    }
}

fn parse_record(buf: &[u8]) -> Result<(Record<'_>, usize), Error> {
    let mut pos = 0usize;
    let mut type_ids_buf = [cbor::Key::Uint(0); MAX_TYPE_IDS];
    let mut type_id_count = 0usize;

    // Phase 1: accumulate typeIDs — contiguous run of uint/byte-string/text-string
    // at the start of the record.
    while pos < buf.len() {
        // Peek at the head to check major type before fully parsing.
        let head = cbor::read_head(&buf[pos..]).map_err(Error::Cbor)?;
        if head.major == 0 || head.major == 2 || head.major == 3 {
            // It's a typeID (uint or byte string). Parse the key.
            let (key, len) = cbor::read_key(&buf[pos..]).map_err(Error::Cbor)?;
            if type_id_count < MAX_TYPE_IDS {
                type_ids_buf[type_id_count] = key;
                type_id_count += 1;
            }
            pos += len;
        } else {
            break;
        }
    }

    // Phase 2: skip non-map items until the map delimiter.
    let mut map_bytes: &[u8] = &[];
    while pos < buf.len() {
        let head = cbor::read_head(&buf[pos..]).map_err(Error::Cbor)?;
        if head.major == 5 {
            // It's a map — the record delimiter.
            let map_len = cbor::skip_any_item(&buf[pos..]).map_err(Error::Cbor)?;
            map_bytes = &buf[pos..pos + map_len];
            pos += map_len;
            break;
        } else {
            // Not a map — skip it (forward-compat unknown item).
            let skip_len = cbor::skip_any_item(&buf[pos..]).map_err(Error::Cbor)?;
            pos += skip_len;
        }
    }

    // Validate field-value-shape (§3.2): walk every field value to
    // ensure it's skip-safe (scalar, definite string, or tag-wrapping-
    // a-string). This catches disallowed shapes early, during parsing,
    // so a well-formed-but-illegal Record never silently passes through.
    if !map_bytes.is_empty() {
        walk_map_pairs(map_bytes, |_k, _v| Ok(ControlFlow::Continue)).map_err(Error::Cbor)?;
    }

    let ignored = type_id_count == 0;

    Ok((
        Record {
            type_ids_buf,
            type_id_count,
            ignored,
            map_bytes,
        },
        pos,
    ))
}

/// Applies the even/odd criticality rule (§3.2) to a Record's map bytes
/// given the set of keys *this* Record-Type handler recognizes. This is
/// Record-Type-specific handling layered on top of the mandatory core
/// (§3.3) — the core itself never calls this, since it has no per-type
/// schema to check against. `on_ignored` is called once per unrecognized
/// odd key (no allocation: caller decides what, if anything, to do with
/// it).
pub fn check_criticality(
    map_bytes: &[u8],
    known_keys: &[u64],
    mut on_ignored: impl FnMut(u64),
) -> Result<CriticalityOutcome, Error> {
    let mut aborted_on: Option<u64> = None;
    walk_map_pairs(map_bytes, |k, _v| {
        // All QDEF map keys are uints (§3). Key 0 is now a regular
        // field key like any other — no special-case skip.
        if let cbor::Key::Uint(key) = k {
            if !known_keys.contains(&key) {
                if key % 2 == 0 {
                    aborted_on = Some(key);
                    return Ok(ControlFlow::Stop);
                }
                on_ignored(key);
            }
        }
        Ok(ControlFlow::Continue)
    })
    .map_err(Error::Cbor)?;

    Ok(match aborted_on {
        Some(k) => CriticalityOutcome::Aborted(k),
        None => CriticalityOutcome::Ok,
    })
}

/// Looks up one key's raw (still-encoded) value bytes in a Record's map.
/// Field-level decoding of what those bytes mean is up to the caller — this
/// is the only piece of "read a specific field" logic the core needs to
/// expose generically.
pub fn find_value<'a>(map_bytes: &'a [u8], key: u64) -> Result<Option<&'a [u8]>, Error> {
    let mut found: Option<&'a [u8]> = None;
    walk_map_pairs(map_bytes, |k, v| {
        if let cbor::Key::Uint(k) = k {
            if k == key {
                found = Some(v);
                return Ok(ControlFlow::Stop);
            }
        }
        Ok(ControlFlow::Continue)
    })
    .map_err(Error::Cbor)?;
    Ok(found)
}

/// Shared pair-walker used by criticality checking and field lookup —
/// one generic "walk a CBOR map's key/value pairs" implementation
/// instead of two near-duplicates. QDEF Record keys are always uints (§3).
fn walk_map_pairs<'a>(
    map_bytes: &'a [u8],
    mut visit: impl FnMut(cbor::Key<'a>, &'a [u8]) -> Result<ControlFlow, cbor::Error>,
) -> Result<usize, cbor::Error> {
    let head = cbor::read_head(map_bytes)?;
    if head.major != 5 {
        return Err(cbor::Error::NotAMap);
    }
    let mut pos = head.head_len;
    let entries = if head.is_indefinite() {
        None
    } else {
        Some(head.arg)
    };
    let mut i: u64 = 0;
    loop {
        if let Some(n) = entries {
            if i >= n {
                break;
            }
        } else if *map_bytes.get(pos).ok_or(cbor::Error::UnexpectedEof)? == 0xFF {
            pos += 1;
            break;
        }

        let (key, klen) = cbor::read_key(&map_bytes[pos..])?;
        pos += klen;
        let vstart = pos;
        let vlen = cbor::skip_value(&map_bytes[pos..])?;
        let value = &map_bytes[vstart..vstart + vlen];
        pos += vlen;

        match visit(key, value)? {
            ControlFlow::Continue => {}
            ControlFlow::Stop => break,
        }
        i += 1;
    }
    Ok(pos)
}

/// Re-exported for callers that want to read a simple text/byte string
/// field's payload out of a value returned by `find_value` (e.g. the Wi-Fi
/// SSID field) without pulling in a full CBOR library themselves.
pub fn read_definite_string(value_bytes: &[u8]) -> Result<&[u8], Error> {
    let (payload, _) = cbor::read_definite_string(value_bytes).map_err(Error::Cbor)?;
    Ok(payload)
}

pub fn read_uint(value_bytes: &[u8]) -> Result<u64, Error> {
    let (v, _) = cbor::read_uint(value_bytes).map_err(Error::Cbor)?;
    Ok(v)
}

/// Re-export the Key enum so callers can pattern-match on typeID types.
pub use cbor::Key;

#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod tests;
