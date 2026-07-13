//! QDEF mandatory core: magic framing, CBOR-Sequence-of-Records walking,
//! key-0 routing, the even/odd criticality rule (docs/QDEF-SPEC.md
//! §2–§3.3). No knowledge of any specific Record Type, no compression,
//! no reassembly — those live in a separate stdlib layer, not here, by
//! design.
//!
//! No version byte: the container is magic + a CBOR Sequence of Records,
//! full stop. Container-level metadata (a format namespace) lives inside
//! the Sequence itself as a Record with the reserved Type ID 0 — an
//! ordinary Record, not special to this crate, since the mandatory core
//! has no per-Type schema knowledge at all. A genuinely incompatible
//! future change to that Record would be a new even/critical key on it,
//! handled by the same even/odd criticality rule below, not by this
//! crate.
//!
//! `no_std`, zero heap allocation, zero dependencies, and — thanks to
//! §3.2's field-value-shape rule (Record field values are always a scalar
//! or a definite-length string, never a bare array/map/tag) — zero
//! recursion anywhere in this crate. Skipping a field this crate doesn't
//! recognize is always exactly one bounded read, never a walk into nested
//! structure. See `cbor::skip_value` and ../../docs/FINDINGS.md.
#![cfg_attr(not(test), no_std)]

mod cbor;

pub const MAGIC: [u8; 4] = *b"QDEF";

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Error {
    TooShortForHeader,
    BadMagic,
    Cbor(cbor::Error),
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum AbortReason {
    /// §3.1: a Record with no key 0 cannot be routed by any parser.
    MissingKeyZero,
    /// §3.1: an odd uint Type ID (key 0) without a declared namespace.
    /// Odd uints are namespace-scoped; using one without a namespace is an error.
    OddKeyWithoutNamespace,
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
                // unlike a well-formed-but-unroutable Record (missing key 0),
                // which aborts only itself. See FINDINGS.md: the spec's
                // "abort just that record" promise silently assumes the
                // record is at least well-formed CBOR. A CBOR-tagged item is
                // one such malformed case now: key 0 is the sole routing
                // mechanism (§3.1), so a tag around a Record is no longer
                // valid Record syntax at all — it's rejected here as "not a
                // map", the same as any other malformed item.
                self.done = true;
                Some(Err(e))
            }
        }
    }
}

/// A routed Record: which Type ID it claims (via key 0, §3.1's sole routing
/// mechanism), and its raw map bytes for a Record-Type-specific handler
/// (e.g. `check_criticality`, `find_value`) to inspect further.
pub struct Record<'a> {
    pub type_id: Option<cbor::Key<'a>>,
    pub aborted: bool,
    pub abort_reason: Option<AbortReason>,
    pub map_bytes: &'a [u8],
}

fn parse_record(buf: &[u8]) -> Result<(Record<'_>, usize), Error> {
    let (key0, map_len) = parse_map_key0(buf).map_err(Error::Cbor)?;
    let map_bytes = &buf[..map_len];

    let (type_id, aborted, abort_reason) = match key0 {
        None => (None, true, Some(AbortReason::MissingKeyZero)),
        Some(key) => (Some(key), false, None),
    };

    Ok((
        Record {
            type_id,
            aborted,
            abort_reason,
            map_bytes,
        },
        map_len,
    ))
}

fn parse_map_key0<'a>(buf: &'a [u8]) -> Result<(Option<cbor::Key<'a>>, usize), cbor::Error> {
    let mut key0: Option<cbor::Key<'a>> = None;
    let mut first = true;
    let consumed = walk_map_pairs(buf, |k, v| {
        if first {
            first = false;
            match k {
                cbor::Key::Uint(0) => {
                    // Key 0's value is the Type ID — a uint (even=standard,
                    // odd=scoped) or a byte string (decentralized). Parse
                    // the value to determine which.
                    let head = cbor::read_head(v)?;
                    match head.major {
                        0 => {
                            key0 = Some(cbor::Key::Uint(head.arg));
                        }
                        2 => {
                            let len = head.arg as usize;
                            let total = head.head_len + len;
                            if v.len() < total {
                                return Err(cbor::Error::UnexpectedEof);
                            }
                            key0 = Some(cbor::Key::ByteString(&v[head.head_len..total]));
                        }
                        _ => {
                            key0 = Some(cbor::Key::Uint(0));
                        } // malformed, caller will handle
                    }
                }
                cbor::Key::ByteString(_) => {
                    // Byte string as key itself (not key 0 with a byte string value)
                    key0 = Some(k);
                }
                _ => {} // first key is not 0; key 0 absent
            }
        }
        Ok(ControlFlow::Continue)
    })?;
    Ok((key0, consumed))
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
        // Key 0 is always skipped (it's the Type ID, not a field key).
        // All non-zero keys in QDEF are uints (§3).
        if let cbor::Key::Uint(key) = k {
            if key != 0 && !known_keys.contains(&key) {
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

/// Shared pair-walker used by key-0 routing, criticality checking, and
/// field lookup alike — one generic "walk a CBOR map's key/value pairs"
/// implementation instead of three near-duplicates. QDEF Record keys are
/// always uints (§3), except key 0 which may also be a byte string (§3.1's
/// three-type classification). A non-uint, non-byte-string key is treated
/// as malformed.
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

/// Re-export the Key enum so callers can pattern-match on key 0's type.
pub use cbor::Key;

#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod tests;
