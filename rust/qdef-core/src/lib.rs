//! QDEF mandatory core: magic framing, CBOR-Sequence-of-Records walking,
//! typeID-prefix routing (§3.1), the even/odd criticality rule
//! (docs/QDEF-SPEC.md §2–§3.3). No knowledge of any specific Record
//! Type, no compression, no reassembly — those live in a separate
//! standard-record-type layer, not here, by design.
//!
//! Every Record is a sequence of CBOR items terminating in a CBOR Map:
//! exactly one typeID-bearing item — a bare uint, or a namespace-pairing
//! array — optionally followed by exactly one bare text string (an
//! NDEF-ID-equivalent external reference, §3.1), followed by zero or more
//! unknown items (forward-compat padding), then the field Map as the
//! record delimiter. There is no backup-typeID accumulation: at most one
//! typeID-bearing item per Record (see docs/FINDINGS.md for why
//! decentralized Type IDs and backup typeIDs were both dropped).
//!
//! No version byte: the container is magic, a mandatory discriminator
//! item, then a CBOR Sequence of Records. Container-level metadata (a
//! format namespace) lives in that discriminator, always the first CBOR
//! item after magic (see header.js in the Node prototype for its
//! shapes and what each one means) — the mandatory core here only knows
//! how to split it off the front, via `cbor::skip_any_item`, never how
//! to interpret it. That interpretation is Record-Type-interpretation-
//! specific handling, entirely outside this crate's scope, same as
//! every other optional mechanism.
//!
//! `no_std`, zero heap allocation, zero dependencies. §3.2's field-value-
//! shape rule was dropped (a field value may now be any well-formed CBOR
//! item, not just a flat scalar or string) — `cbor::skip_any_item`'s
//! bounded explicit stack (no true recursion) now handles both prefix-
//! item skipping and field-value skipping identically. See
//! ../../docs/FINDINGS.md.
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
pub enum CriticalityOutcome {
    Ok,
    /// §3.2: an unrecognized even key aborted this record. Carries the key.
    Aborted(u64),
}

enum ControlFlow {
    Continue,
    Stop,
}

/// A parsed QDEF container: valid magic, its mandatory discriminator
/// item (raw, uninterpreted — see the crate-level doc comment), and the
/// CBOR Sequence of Records that follows it.
pub struct Container<'a> {
    discriminator: &'a [u8],
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
        let rest = &buf[4..];
        let disc_len = cbor::skip_any_item(rest).map_err(Error::Cbor)?;
        Ok(Container {
            discriminator: &rest[..disc_len],
            seq: &rest[disc_len..],
        })
    }

    /// The raw, uninterpreted bytes of the mandatory discriminator item.
    /// This crate never inspects its shape or meaning — that's an
    /// optional, Record-Type-interpretation-layer concern (see
    /// header.js in the Node prototype for the equivalent).
    pub fn discriminator(&self) -> &'a [u8] {
        self.discriminator
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
                // unlike a well-formed Record with no typeID (ignored),
                // which skips only itself.
                self.done = true;
                Some(Err(e))
            }
        }
    }
}

/// A routed Record: its typeID (via the prefix item, §3.1's routing
/// mechanism), its optional NDEF-ID text string, and its raw map bytes
/// for a Record-Type-specific handler (e.g. `check_criticality`,
/// `find_value`) to inspect further.
pub struct Record<'a> {
    /// This Record's typeID, if it had one. `None` iff `ignored`.
    type_id: Option<cbor::Key<'a>>,
    /// The namespace from this Record's own namespace-pairing prefix
    /// item, if it had one — raw, uninterpreted (same treatment as
    /// `Container::discriminator()`). `None` means this Record declared
    /// no override; interpretation-layer code falls back to whatever
    /// ambient namespace the container discriminator declared.
    local_namespace: Option<cbor::Key<'a>>,
    /// The raw bytes of this Record's NDEF-ID-equivalent text string
    /// (§3.1), if present. Uninterpreted -- this crate only recognizes
    /// the shape (a bare text string immediately following the typeID
    /// item), never what the string means.
    ndef_id: Option<&'a [u8]>,
    /// True if no typeID was found before the map — the record is
    /// unroutable and should be ignored by dispatch logic.
    pub ignored: bool,
    /// The field map bytes (from the map delimiter to the end of the
    /// map). Empty slice if no map was found (incomplete record).
    pub map_bytes: &'a [u8],
}

impl<'a> Record<'a> {
    /// This Record's typeID, if any.
    pub fn type_id(&self) -> Option<cbor::Key<'a>> {
        self.type_id
    }

    /// The raw namespace value from this Record's own namespace-pairing
    /// prefix item, if any. This crate never interprets it (doesn't
    /// know it means "namespace," doesn't check even/odd, doesn't
    /// compare it against a container's ambient discriminator) — that's
    /// entirely a Record-Type-interpretation-layer concern (see
    /// header.js's `resolveLookupKeyForRecord` in the Node prototype).
    pub fn local_namespace(&self) -> Option<cbor::Key<'a>> {
        self.local_namespace
    }

    /// The raw bytes of this Record's NDEF-ID-equivalent text string
    /// (§3.1), if present.
    pub fn ndef_id(&self) -> Option<&'a [u8]> {
        self.ndef_id
    }
}

fn parse_record(buf: &[u8]) -> Result<(Record<'_>, usize), Error> {
    let mut pos = 0usize;
    let mut type_id: Option<cbor::Key<'_>> = None;
    let mut local_namespace: Option<cbor::Key<'_>> = None;
    let mut ndef_id: Option<&[u8]> = None;

    // Phase 1: recognize this Record's single typeID-bearing item -- a
    // bare uint, or a namespace-pairing array -- then its optional
    // NDEF-ID text string.
    if pos < buf.len() {
        let head = cbor::read_head(&buf[pos..]).map_err(Error::Cbor)?;
        if head.major == 0 {
            // Bare uint typeID -- the only valid bare typeID shape now
            // (byte string and text string Type IDs were both retired,
            // see docs/FINDINGS.md).
            let (key, len) = cbor::read_key(&buf[pos..]).map_err(Error::Cbor)?;
            type_id = Some(key);
            pos += len;
        } else if head.major == 4 && !head.is_indefinite() && head.arg == 2 {
            // Candidate namespace-pairing item: [namespace, typeId].
            // Purely structural recognition — this crate never learns
            // what a namespace means, only that this specific 2-element
            // shape yields one typeId candidate plus an opaque side
            // value. If the two elements don't match the expected
            // shape, this isn't a pairing after all; Phase 2 skips the
            // whole array generically, same as any other unrecognized
            // item.
            let elems_start = pos + head.head_len;
            if let Some((ns, id, elems_len)) =
                parse_namespace_pairing(&buf[elems_start..]).map_err(Error::Cbor)?
            {
                local_namespace = Some(ns);
                type_id = Some(cbor::Key::Uint(id));
                pos = elems_start + elems_len;
            }
        }
    }

    // The NDEF-ID text string only follows a *recognized* typeID item --
    // a bare text string with no preceding typeID is not this Record's
    // NDEF-ID, it's an unrouted Record's first unrecognized item (Phase
    // 2 skips it as forward-compat padding, same as before).
    if type_id.is_some() && pos < buf.len() {
        let head = cbor::read_head(&buf[pos..]).map_err(Error::Cbor)?;
        if head.major == 3 && !head.is_indefinite() {
            let (payload, len) = cbor::read_definite_string(&buf[pos..]).map_err(Error::Cbor)?;
            ndef_id = Some(payload);
            pos += len;
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

    // Well-formedness check: walk every field value once so a truncated
    // or malformed map is caught during parsing, not silently passed
    // through. §3.2 no longer restricts field-value *shape* (any
    // well-formed CBOR item is legal now), so this only ever checks
    // well-formedness, never shape.
    if !map_bytes.is_empty() {
        walk_map_pairs(map_bytes, |_k, _v| Ok(ControlFlow::Continue)).map_err(Error::Cbor)?;
    }

    let ignored = type_id.is_none();

    Ok((
        Record {
            type_id,
            local_namespace,
            ndef_id,
            ignored,
            map_bytes,
        },
        pos,
    ))
}

/// Attempts to parse the two elements of a namespace-pairing array's
/// contents (the slice starting right after the array's own head): a
/// namespace (a byte string — the only valid Namespace ID shape, same
/// convention as the container discriminator's namespace value, §3.5;
/// there is no Allocated/uint namespace tier) followed by a typeId
/// (uint only — a namespace-pairing item never carries a byte-string
/// typeId; decentralized Record IDs were retired entirely, §3.1).
///
/// Returns `Ok(None)` — not an error — when the two elements are
/// well-formed CBOR but don't match this shape (e.g. the namespace slot
/// holds a uint or a text string, or the typeId slot holds something
/// other than a uint): that means this array isn't a namespace pairing
/// after all, and the caller falls back to treating it as an ordinary
/// unrecognized prefix item. Only a genuine decode failure
/// (truncated/malformed bytes) propagates as `Err`.
fn parse_namespace_pairing(buf: &[u8]) -> Result<Option<(cbor::Key<'_>, u64, usize)>, cbor::Error> {
    let (ns_key, ns_len) = match cbor::read_key(buf) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let ns_valid = matches!(ns_key, cbor::Key::ByteString(_));
    if !ns_valid {
        return Ok(None);
    }

    let rest = buf.get(ns_len..).ok_or(cbor::Error::UnexpectedEof)?;
    let (id_key, id_len) = match cbor::read_key(rest) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let id = match id_key {
        cbor::Key::Uint(n) => n,
        _ => return Ok(None),
    };

    Ok(Some((ns_key, id, ns_len + id_len)))
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
        // Record-Type-owned keys are always non-negative (Key::Uint).
        // Key 0 is a regular field key like any other — no special-case
        // skip. Negative keys (Key::NegInt), byte-string keys, and
        // text-string keys are silently skipped here -- not this Type's
        // to interpret.
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
/// instead of two near-duplicates. Field values may be any well-formed
/// CBOR item now (§3.2's shape rule was dropped) — `cbor::skip_any_item`
/// handles skipping any of them, container or scalar alike.
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
        let vlen = cbor::skip_any_item(&map_bytes[pos..])?;
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
/// SSID field) without pulling in a full CBOR library themselves. Only
/// covers the common, definite-length case -- a field value that turns
/// out to be something more exotic (an indefinite-length string, a
/// nested container) needs a real CBOR library to decode fully, the same
/// way it always did for containers even before §3.2's shape rule was
/// dropped.
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
