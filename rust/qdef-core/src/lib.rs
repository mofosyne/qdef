//! QDEF mandatory core: magic framing, typeID-prefix routing (§3.1), the
//! even/odd criticality rule (docs/QDEF-SPEC.md §2–§3.3). No knowledge
//! of any specific Record Type, no compression, no reassembly — those
//! live in a separate standard-record-type layer, not here, by design.
//!
//! There is exactly one grammar, applied identically everywhere -- the
//! container root, an NDEF/own-URI-scheme body, and every subrecord all
//! parse the same way, the only difference being what bounds the item
//! list (end-of-buffer for the first two, an explicit array for the
//! last). No separate "container discriminator" concept exists (see
//! docs/DESIGN.md and docs/FINDINGS.md for why: it collapsed into this
//! same grammar once typeId became optional):
//! `[namespace?, typeId?, map?, payload?, subrecord*]`
//! - namespace (optional): a byte string. Recognized whenever the
//!   current position holds one, unconditionally -- there is no
//!   requirement that a valid typeId immediately follow it (dropped
//!   deliberately; see docs/DESIGN.md). Scopes this Record's own
//!   typeId, overriding any inherited ambient namespace for this one
//!   Record (and, by cascade, its own subrecords) only.
//! - typeId (optional): a bare uint. Defaults to 0 (Bundle) when no
//!   uint is found at this position -- a forgiving-parser choice, not
//!   an error case (see docs/DESIGN.md). No other shape is recognized
//!   and there is no backup-typeId accumulation.
//! - map (optional): the field Map, omitted when empty (§3.1). Major
//!   type 5 immediately after typeId (or namespace/typeId) is always the
//!   field Map -- never padding, never payload.
//! - payload (optional): whatever remains immediately after the map (or
//!   after typeId when no map is present) is this Record's payload, of
//!   any well-formed, definite-length CBOR shape EXCEPT an array
//!   (§3.1/§3.2 -- the same shape rule field values already have, minus
//!   major type 4). Arrays are excluded specifically so a bare array in
//!   this position is always unambiguously the start of subrecords, no
//!   marker needed (array-shaped payload was tried and reverted after
//!   real adopter feedback -- see docs/DESIGN.md). A map-shaped payload
//!   requires the field Map to also be present (even empty), since major
//!   type 5 right after typeId is otherwise always the field Map.
//! - subrecord* (zero or more): every remaining item after the payload
//!   is itself a nested Record, recursively the same shape, always
//!   array-wrapped -- a subrecord's own boundary must be self-delimited
//!   since it sits inside a larger item list, unlike the outermost list
//!   itself.
//!
//! A malformed *inner* Record (one whose own array contents don't parse
//! as valid Record grammar) never corrupts a sibling Record's
//! discoverability: `Records::next` always determines a Record's total
//! byte span generically, via `cbor::skip_any_item` on its whole array,
//! *before* attempting to interpret its contents — so the Sequence walker
//! can always advance to the next sibling regardless of whether this one
//! Record's own interpretation succeeds.
//!
//! No version byte: the container is magic followed directly by the
//! root Record's own items -- no discriminator, no CBOR Sequence of
//! independent top-level Records. The root is otherwise an ordinary
//! Record: it MAY carry a real typeId of its own (a single primary
//! Record, e.g. a Media Payload, needs no Bundle indirection at all),
//! or omit typeId to default to Bundle (0) when the container holds
//! several co-equal top-level Records, which then live in its
//! subrecords.
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
    /// §3.2: an unrecognized even key aborted this record. Carries the
    /// key's actual signed value -- negative for a Common Field Key
    /// (§3.6), non-negative for a Record-Type-owned key.
    Aborted(i64),
}

enum ControlFlow {
    Continue,
    Stop,
}

/// A parsed QDEF container: valid magic followed by the root Record's
/// own items, end-of-buffer-bounded (see `parse_record_items`). No
/// discriminator to skip or interpret -- the root's own namespace/map
/// fields (if any) carry exactly the job a separate discriminator item
/// used to (see the crate-level doc comment).
pub struct Container<'a> {
    root: Record<'a>,
}

impl<'a> Container<'a> {
    pub fn parse(buf: &'a [u8]) -> Result<Self, Error> {
        if buf.len() < 4 {
            return Err(Error::TooShortForHeader);
        }
        if buf[0..4] != MAGIC {
            return Err(Error::BadMagic);
        }
        let root = parse_record_items(&buf[4..], 0)?;
        Ok(Container { root })
    }

    /// The container's root Record -- an ordinary Record like any
    /// other, which MAY carry a real typeId of its own (a single
    /// primary Record needs no Bundle indirection) or default to
    /// typeId 0 (Bundle) when the container holds several co-equal
    /// top-level Records, which then live in `root().subrecords()`.
    pub fn root(&self) -> &Record<'a> {
        &self.root
    }
}

/// The NDEF path (§2): a bare CBOR Sequence with no magic prefix,
/// because NDEF's own MIME type (`application/vnd.qdef`) already
/// identifies the payload. Structurally identical to `Container::parse`
/// past the magic check: one Record, end-of-buffer-bounded.
pub fn record_from_sequence(seq: &[u8]) -> Result<Record<'_>, Error> {
    parse_record_items(seq, 0)
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
    /// This Record's typeID. Always present -- defaults to `Key::Uint(0)`
    /// (Bundle) when no uint was found at the typeId position (§3.1's
    /// forgiving-parser choice; see docs/DESIGN.md). There is no
    /// "ignored, unroutable" state anymore.
    type_id: cbor::Key<'a>,
    /// The namespace from this Record's own namespace-pairing prefix
    /// item, if it had one — raw, uninterpreted. `None` means this
    /// Record declared no override; interpretation-layer code falls
    /// back to whatever ambient namespace it inherited.
    local_namespace: Option<cbor::Key<'a>>,
    /// The raw encoded bytes of this Record's payload item (§3.1), if
    /// present -- of whatever CBOR shape it turned out to be (byte/text
    /// string, uint, map, ...), never an array. Uninterpreted by this
    /// crate.
    payload: Option<&'a [u8]>,
    /// The raw bytes of every array element following this Record's own
    /// payload — its subrecords, if any. `None` means no elements
    /// followed the payload (or the map when no payload present).
    sub_bytes: Option<&'a [u8]>,
    /// The field map bytes (from the map delimiter to the end of the
    /// map). Empty slice if no map was found.
    pub map_bytes: &'a [u8],
}

impl<'a> Record<'a> {
    /// This Record's typeID -- always present, defaulting to `Key::Uint(0)`.
    pub fn type_id(&self) -> cbor::Key<'a> {
        self.type_id
    }

    /// The raw namespace value from this Record's own namespace-pairing
    /// prefix item, if any. This crate never interprets it (doesn't
    /// know it means "namespace," doesn't check even/odd, doesn't
    /// compare it against any ambient one it might override) — that's
    /// entirely a Record-Type-interpretation-layer concern (see
    /// header.js's `resolveLookupKeyForRecord` in the Node prototype).
    pub fn local_namespace(&self) -> Option<cbor::Key<'a>> {
        self.local_namespace
    }

    /// The raw encoded bytes of this Record's payload item (§3.1), if
    /// present, of whatever CBOR shape it turned out to be (never an
    /// array -- see `subrecords` for nested Records). Uninterpreted by
    /// this crate -- use `qdef_core::read_definite_string`/`read_uint`
    /// for a string/uint-shaped payload, or a raw CBOR read for anything
    /// else.
    pub fn payload(&self) -> Option<&'a [u8]> {
        self.payload
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
/// `cbor::skip_any_item` before calling this function). Reads past the
/// array's own header, then hands the rest to `parse_record_items`,
/// which walks the shared grammar identically whether the item list
/// came from an explicit array or an end-of-buffer-bounded body.
fn parse_record_array(buf: &[u8]) -> Result<Record<'_>, Error> {
    let head = cbor::read_head(buf).map_err(Error::Cbor)?;
    parse_record_items(buf, head.head_len)
}

/// Parses one Record from a flat, already-bounded run of CBOR items:
/// `buf[start..]` is exactly that run, with `buf.len()` as its end --
/// either a subrecord's own array elements (start = the array's own
/// header length, see `parse_record_array`), or an entire end-of-buffer-
/// bounded body (the container root, an NDEF/own-URI body). No
/// structural difference between these contexts: this one function
/// serves both.
///
///   `[namespace?, typeId?, map?, payload?, subrecord*]`
///
/// - namespace: recognized whenever the current item is a byte string,
///   unconditionally -- no longer requires a following valid typeId
///   (dropped; see docs/DESIGN.md).
/// - typeId: a bare uint (major type 0) if present at this position;
///   absent, defaults to `Key::Uint(0)` (Bundle). No other shape is
///   recognized as a typeId.
/// - map: the item immediately following typeId, if map-shaped.
///   Optional -- absent when empty (§3.1). Major type 5 in this position
///   is unconditionally the field Map, never padding, never payload.
/// - payload: whatever remains immediately after the map (or typeId if
///   no map), if present and not array-shaped, of any well-formed,
///   definite-length CBOR shape. An array in this position is never
///   payload -- it's always subrecord 0.
/// - subrecords: everything remaining after the payload to `buf.len()`.
fn parse_record_items(buf: &[u8], start: usize) -> Result<Record<'_>, Error> {
    let mut pos = start;

    let mut type_id = cbor::Key::Uint(0); // defaults to Bundle
    let mut local_namespace: Option<cbor::Key<'_>> = None;
    let mut payload: Option<&[u8]> = None;

    // namespace: a byte string at this position is always the
    // namespace, unconditionally -- no lookahead pairing required.
    if pos < buf.len() {
        let item_head = cbor::read_head(&buf[pos..]).map_err(Error::Cbor)?;
        if item_head.major == 2 {
            let (ns_key, ns_len) = cbor::read_key(&buf[pos..]).map_err(Error::Cbor)?;
            local_namespace = Some(ns_key);
            pos += ns_len;
        }
    }

    // typeId: a uint at this position, if present; absent, stays the
    // Key::Uint(0) default.
    if pos < buf.len() {
        let item_head = cbor::read_head(&buf[pos..]).map_err(Error::Cbor)?;
        if item_head.major == 0 {
            let (id_key, id_len) = cbor::read_key(&buf[pos..]).map_err(Error::Cbor)?;
            type_id = id_key;
            pos += id_len;
        }
    }

    // Map, if present, immediately after typeId -- major type 5 in this
    // position is always the field Map, never padding, never payload
    // (§3.1's map-shape carve-out: a map-shaped payload requires this
    // slot to be explicitly, even emptily, present).
    let mut map_bytes: &[u8] = &[];
    if pos < buf.len() {
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
    // no map was found) is this Record's payload, of any well-formed,
    // definite-length CBOR shape (§3.1/§3.2) EXCEPT an array -- an array
    // here is never payload, always subrecord 0 (no marker needed to
    // tell the two apart; array-shaped payload was tried and reverted,
    // see docs/DESIGN.md). An indefinite-length item here is not
    // recognized either (matches the pre-existing bstr/tstr decoder-
    // tolerance divergence, docs/QDEF-SPEC.md §3.1) -- it falls through
    // to subrecord-scanning instead, skipped again there as a non-array
    // item.
    if pos < buf.len() {
        let item_head = cbor::read_head(&buf[pos..]).map_err(Error::Cbor)?;
        if !item_head.is_indefinite() && item_head.major != 4 {
            let item_len = cbor::skip_any_item(&buf[pos..]).map_err(Error::Cbor)?;
            payload = Some(&buf[pos..pos + item_len]);
            pos += item_len;
        }
    }

    // Everything remaining to buf.len() is subrecords.
    let sub_bytes: Option<&[u8]> = if pos < buf.len() {
        Some(&buf[pos..])
    } else {
        None
    };

    Ok(Record {
        type_id,
        local_namespace,
        payload,
        sub_bytes,
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
    known_keys: &[i64],
    mut on_ignored: impl FnMut(i64),
) -> Result<CriticalityOutcome, Error> {
    let mut aborted_on: Option<i64> = None;
    walk_map_pairs(map_bytes, |k, _v| {
        // Criticality (even/odd, §3.2) applies uniformly to any
        // integer-shaped key: Record-Type-owned non-negative keys
        // (Key::Uint) and the spec-governed Common Field Key tier
        // (Key::NegInt, negative, §3.6) alike -- parity is well-defined
        // on the actual mathematical value either way, not just on
        // non-negative ones. Byte-string and text-string keys have no
        // defined parity and stay exempt, not this Type's to interpret
        // regardless of key shape.
        //
        // Key::NegInt carries the *raw CBOR argument*, not the actual
        // value -- RFC 8949 §3.1: a major-type-1 item's real value is
        // `-1 - arg`. Converting to the real value before checking
        // parity matters: arg's own parity is the *inverse* of the
        // value's (arg 0 -> value -1, odd; arg 1 -> value -2, even), so
        // checking `arg % 2` directly would classify every negative key
        // backwards.
        let value: Option<i64> = match k {
            cbor::Key::Uint(v) => i64::try_from(v).ok(),
            cbor::Key::NegInt(arg) => i64::try_from(arg).ok().map(|a| -1 - a),
            _ => None,
        };
        if let Some(key) = value {
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
