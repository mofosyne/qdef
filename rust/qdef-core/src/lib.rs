//! QDEF mandatory core: magic framing, CBOR-Sequence-of-Records walking,
//! typeID-prefix routing (§3.1), the even/odd criticality rule
//! (docs/QDEF-SPEC.md §2–§3.3). No knowledge of any specific Record
//! Type, no compression, no reassembly — those live in a separate
//! standard-record-type layer, not here, by design.
//!
//! Every Record is exactly one definite-length CBOR array, self-bounded
//! by its own array header — a decoder never needs Record-grammar
//! knowledge to skip past a Record it doesn't care about, only to skip
//! one generic CBOR array (see docs/DESIGN.md for why this replaced the
//! earlier flat, unwrapped Record shape). Its elements, in order:
//! `[namespace?, typeId, map?, payload?, subrecord*]`
//! - namespace (optional): a byte string, present only when the array's
//!   first element is a byte string immediately followed by a valid
//!   typeId. Scopes this Record's own typeId, overriding any container-
//!   level ambient namespace for this one Record only (§3.5).
//! - typeId (mandatory): a bare uint. No other shape is recognized and
//!   there is no backup-typeId accumulation — at most one typeId per
//!   Record (see docs/FINDINGS.md for why decentralized Type IDs, Named
//!   Type IDs, and backup typeIDs were all retired).
//! - map (optional): the field Map, omitted when empty (§3.1). Major
//!   type 5 immediately after typeId (or namespace/typeId) is always the
//!   field Map -- never padding, never payload.
//! - payload (optional): whatever remains immediately after the map (or
//!   after typeId when no map is present) is unconditionally this
//!   Record's payload, of any well-formed, definite-length CBOR shape
//!   (§3.1/§3.2 -- the same shape rule field values already have,
//!   including a nested Record). A bare `null` is the explicit "no real
//!   payload, but subrecords follow" placeholder a conformant encoder
//!   emits so a trailing array is never ambiguous between "the payload
//!   is a Record" and "no payload, this is subrecord 0" -- exposed as
//!   `None`, the same as true absence. A map-shaped payload requires the
//!   field Map to also be present (even empty), since major type 5 right
//!   after typeId is otherwise always the field Map.
//! - subrecord* (zero or more): every remaining array element after the
//!   payload is itself a nested Record, recursively the same shape. No
//!   separate wrapper array is needed: the outer Record's own array is
//!   already self-bounded.
//!
//! A malformed *inner* Record (one whose own array contents don't parse
//! as valid Record grammar) never corrupts a sibling Record's
//! discoverability: `Records::next` always determines a Record's total
//! byte span generically, via `cbor::skip_any_item` on its whole array,
//! *before* attempting to interpret its contents — so the Sequence walker
//! can always advance to the next sibling regardless of whether this one
//! Record's own interpretation succeeds.
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
        loop {
            if self.done || self.remaining.is_empty() {
                return None;
            }
            let head = match cbor::read_head(self.remaining) {
                Ok(h) => h,
                Err(e) => {
                    self.done = true;
                    return Some(Err(Error::Cbor(e)));
                }
            };
            if head.major == 4 && !head.is_indefinite() {
                // A definite-length array is a Record. Determine its
                // total byte span *generically* first (skip_any_item only
                // needs the bytes to be well-formed CBOR, not valid
                // Record grammar) -- this Sequence can always find the
                // next sibling afterward, regardless of whether this
                // Record's own contents happen to parse as valid Record
                // grammar.
                let total_len = match cbor::skip_any_item(self.remaining) {
                    Ok(len) => len,
                    Err(e) => {
                        self.done = true;
                        return Some(Err(Error::Cbor(e)));
                    }
                };
                let record_bytes = &self.remaining[..total_len];
                self.remaining = &self.remaining[total_len..];
                return Some(parse_record_array(record_bytes));
            } else {
                // Not a Record array -- not a Record at all, skip it
                // generically (forward-compat tolerance, the same
                // principle Phase 2 already applies inside a Record) and
                // keep scanning for the next array.
                match cbor::skip_any_item(self.remaining) {
                    Ok(len) => {
                        self.remaining = &self.remaining[len..];
                        continue;
                    }
                    Err(e) => {
                        self.done = true;
                        return Some(Err(Error::Cbor(e)));
                    }
                }
            }
        }
    }
}

/// A routed Record: its typeID (via the prefix item, §3.1's routing
/// mechanism), its raw payload bytes, and its raw map bytes
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
    /// The raw encoded bytes of this Record's payload item (§3.1), if
    /// present -- of whatever CBOR shape it turned out to be (byte/text
    /// string, uint, map, or an array meaning the payload is itself a
    /// nested Record). Uninterpreted by this crate; a `null` placeholder
    /// (meaning "no real payload, subrecords follow") is normalized to
    /// `None` here, same as true absence.
    payload: Option<&'a [u8]>,
    /// The raw bytes of every array element following this Record's own
    /// payload — its subrecords, if any. `None` means no elements
    /// followed the payload (or the map when no payload present).
    sub_bytes: Option<&'a [u8]>,
    /// True if no typeID was found — the record is unroutable and
    /// should be ignored by dispatch logic.
    pub ignored: bool,
    /// The field map bytes (from the map delimiter to the end of the
    /// map). Empty slice if no map was found.
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

    /// The raw encoded bytes of this Record's payload item (§3.1), if
    /// present, of whatever CBOR shape it turned out to be. Uninterpreted
    /// by this crate -- use `payload_as_record` when the payload is
    /// array-shaped, `qdef_core::read_definite_string`/`read_uint` for a
    /// string/uint-shaped payload, or a raw CBOR read for anything else.
    pub fn payload(&self) -> Option<&'a [u8]> {
        self.payload
    }

    /// If this Record's payload is itself array-shaped (major type 4),
    /// parses it as a nested Record using the exact same grammar as a
    /// subrecord or the top-level Sequence -- not a separate shape.
    /// `None` if there is no payload, or it isn't array-shaped.
    pub fn payload_as_record(&self) -> Option<Result<Record<'a>, Error>> {
        let bytes = self.payload?;
        let head = cbor::read_head(bytes).ok()?;
        if head.major != 4 {
            return None;
        }
        Some(parse_record_array(bytes))
    }

    /// This Record's own subrecords, if any — an iterator over the
    /// array elements following this Record's payload (or map, when no
    /// payload is present), parsed with the exact same Record grammar as
    /// the top-level Sequence (the same `Records` iterator, reused
    /// recursively, not a new grammar). `None` if no elements followed
    /// at all.
    pub fn subrecords(&self) -> Option<Records<'a>> {
        self.sub_bytes.map(|b| Records {
            remaining: b,
            done: false,
        })
    }
}

/// Parses a single Record from its own, already-length-bounded CBOR
/// array (`buf` is exactly one Record's worth of bytes -- its own array
/// header plus every one of its declared elements, no more, no less;
/// see `Records::next`, which determines this bound generically via
/// `cbor::skip_any_item` before calling this function):
///   `[namespace?, typeId, map?, payload?, subrecord*]`
///
/// - namespace: recognized only when the array's first element is a
///   byte string AND the element immediately after it is a valid
///   typeId -- otherwise this Record has no typeId at all (`ignored`),
///   the same "malformed prefix means unroutable, not a crash"
///   tolerance as before.
/// - typeId: a bare uint (major type 0). No other shape is recognized.
/// - map: the element immediately following typeId, if map-shaped.
///   Optional -- absent when empty (§3.1). Major type 5 in this position
///   is unconditionally the field Map, never padding, never payload.
/// - payload: whatever remains immediately after the map (or typeId if
///   no map), of any well-formed, definite-length CBOR shape, if
///   present -- a `null` placeholder is normalized to `None`.
/// - subrecords: everything remaining after the payload to the end of
///   this Record's own (already exactly bounded) array.
fn parse_record_array(buf: &[u8]) -> Result<Record<'_>, Error> {
    let head = cbor::read_head(buf).map_err(Error::Cbor)?;
    let mut remaining_items = head.arg;
    let mut pos = head.head_len;

    let mut type_id: Option<cbor::Key<'_>> = None;
    let mut local_namespace: Option<cbor::Key<'_>> = None;
    let mut payload: Option<&[u8]> = None;

    // [namespace?] typeId
    if remaining_items > 0 {
        let item_head = cbor::read_head(&buf[pos..]).map_err(Error::Cbor)?;
        if item_head.major == 2 && remaining_items > 1 {
            let (ns_key, ns_len) = cbor::read_key(&buf[pos..]).map_err(Error::Cbor)?;
            let next_pos = pos + ns_len;
            let next_head = cbor::read_head(&buf[next_pos..]).map_err(Error::Cbor)?;
            if next_head.major == 0 {
                let (id_key, id_len) = cbor::read_key(&buf[next_pos..]).map_err(Error::Cbor)?;
                local_namespace = Some(ns_key);
                type_id = Some(id_key);
                pos = next_pos + id_len;
                remaining_items -= 2;
            }
        } else if item_head.major == 0 {
            let (id_key, id_len) = cbor::read_key(&buf[pos..]).map_err(Error::Cbor)?;
            type_id = Some(id_key);
            pos += id_len;
            remaining_items -= 1;
        }
    }

    // Map, if present, immediately after typeId -- major type 5 in this
    // position is always the field Map, never padding, never payload
    // (§3.1's map-shape carve-out: a map-shaped payload requires this
    // slot to be explicitly, even emptily, present).
    let mut map_bytes: &[u8] = &[];
    if remaining_items > 0 {
        let item_head = cbor::read_head(&buf[pos..]).map_err(Error::Cbor)?;
        if item_head.major == 5 {
            let item_len = cbor::skip_any_item(&buf[pos..]).map_err(Error::Cbor)?;
            map_bytes = &buf[pos..pos + item_len];
            pos += item_len;
        }
    }

    // Well-formedness check.
    if !map_bytes.is_empty() {
        walk_map_pairs(map_bytes, |_k, _v| Ok(ControlFlow::Continue)).map_err(Error::Cbor)?;
    }

    // Payload: whatever remains immediately after the map (or typeId if
    // no map was found) is unconditionally this Record's payload, of any
    // well-formed, definite-length CBOR shape (§3.1/§3.2) -- a bare
    // `null` is the explicit "no real payload, but subrecords follow"
    // placeholder and is left as `None`. An indefinite-length item here
    // is not recognized (generalizes the pre-existing bstr/tstr decoder-
    // tolerance divergence, docs/QDEF-SPEC.md §3.1, to every shape) --
    // it falls through to subrecord-scanning instead, skipped again
    // there as a non-array item. Only recognized for routed records
    // (type_id.is_some()).
    if type_id.is_some() && pos < buf.len() {
        let item_head = cbor::read_head(&buf[pos..]).map_err(Error::Cbor)?;
        if !item_head.is_indefinite() {
            let item_len = cbor::skip_any_item(&buf[pos..]).map_err(Error::Cbor)?;
            let is_null_placeholder = item_head.major == 7 && item_head.arg == 22;
            if !is_null_placeholder {
                payload = Some(&buf[pos..pos + item_len]);
            }
            pos += item_len;
        }
    }

    // Everything remaining to the end of this Record's own (already
    // exactly bounded) array is subrecords.
    let sub_bytes: Option<&[u8]> = if pos < buf.len() {
        Some(&buf[pos..])
    } else {
        None
    };

    let ignored = type_id.is_none();

    Ok(Record {
        type_id,
        local_namespace,
        payload,
        sub_bytes,
        ignored,
        map_bytes,
    })
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
