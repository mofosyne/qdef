//! QDEF mandatory core: magic framing, namespace/typeId routing, the
//! even/odd criticality rule (docs/QDEF-SPEC.md §2–§3.3). No knowledge
//! of any specific Record Type, no compression, no reassembly.
//!
//! Grammar (same for root, subrecord, and Wrapper inner bytes):
//! ```text
//! [namespace?, ns_annotation?, typeId*, type_annotation?, map?, subrecord*]
//! ```
//! - namespace (optional): bstr at position 0. Empty = inherit parent's.
//! - ns_annotation (optional): tstr immediately after namespace.
//! - typeId*: consecutive uints after namespace/ns_annotation. Absent = Bundle.
//! - type_annotation (optional): tstr immediately after last typeId uint.
//! - map (optional): major 5. Key 0 = payload. Keys > 0 have even/odd criticality.
//! - subrecord*: remaining arrays.
//!
//! `no_std`, zero heap allocation, zero dependencies.
#![cfg_attr(not(test), no_std)]

mod cbor;

pub const MAGIC: [u8; 4] = *b"QDEF";
/// Max typeId sequence length supported by this core parser.
pub const MAX_TYPEID_LEN: usize = 8;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Error {
    TooShortForHeader,
    BadMagic,
    Cbor(cbor::Error),
    /// A text string appeared where no namespace or typeId preceded it.
    BareAnnotation,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum CriticalityOutcome {
    Ok,
    /// An unrecognized even key (> 0) aborted this record.
    Aborted(i64),
}

enum ControlFlow {
    Continue,
    Stop,
}

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
        let root = parse_root_record(&buf[4..])?;
        Ok(Container { root })
    }

    pub fn root(&self) -> &Record<'a> {
        &self.root
    }
}

pub fn record_from_sequence(seq: &[u8]) -> Result<Record<'_>, Error> {
    parse_root_record(seq)
}

fn parse_root_record(buf: &[u8]) -> Result<Record<'_>, Error> {
    let head = cbor::read_head(buf).map_err(Error::Cbor)?;
    if head.major != 4 || head.is_indefinite() {
        return Err(Error::Cbor(cbor::Error::NotAnArray));
    }
    let total_len = cbor::skip_any_item(buf).map_err(Error::Cbor)?;
    parse_record_array(&buf[..total_len])
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

/// A parsed Record. Core parsing only — does not interpret field meanings.
pub struct Record<'a> {
    /// The raw namespace bytes if present (bstr, or empty for inherit).
    local_namespace: Option<&'a [u8]>,
    /// The ns annotation bytes if present (tstr).
    ns_annotation: Option<&'a [u8]>,
    /// The typeId sequence: up to MAX_TYPEID_LEN uints.
    type_id: [u64; MAX_TYPEID_LEN],
    /// Number of valid uints in type_id.
    type_id_len: usize,
    /// The type annotation bytes if present (tstr).
    type_annotation: Option<&'a [u8]>,
    /// The field map bytes (from map header to map end). Empty if no map.
    pub map_bytes: &'a [u8],
    /// Subrecords raw bytes, if any.
    sub_bytes: Option<&'a [u8]>,
}

impl<'a> Record<'a> {
    pub fn type_id(&self) -> &[u64] {
        &self.type_id[..self.type_id_len]
    }

    pub fn local_namespace(&self) -> Option<&'a [u8]> {
        self.local_namespace
    }

    pub fn ns_annotation(&self) -> Option<&'a [u8]> {
        self.ns_annotation
    }

    pub fn type_annotation(&self) -> Option<&'a [u8]> {
        self.type_annotation
    }

    pub fn subrecords(&self) -> Option<Records<'a>> {
        self.sub_bytes.map(|b| Records {
            remaining: b,
            done: false,
        })
    }

    /// Read payload at map key 0, if present.
    pub fn payload_bytes(&self) -> Result<Option<&'a [u8]>, Error> {
        Ok(find_value(self.map_bytes, 0).map_err(Error::Cbor)?)
    }
}

fn parse_record_array(buf: &[u8]) -> Result<Record<'_>, Error> {
    let head = cbor::read_head(buf).map_err(Error::Cbor)?;
    parse_record_items(buf, head.head_len)
}

/// Parses one Record: `[namespace?, ns_annotation?, typeId*, type_annotation?, map?, subrecord*]`
fn parse_record_items(buf: &[u8], start: usize) -> Result<Record<'_>, Error> {
    let mut pos = start;

    let mut local_namespace: Option<&[u8]> = None;
    let mut ns_annotation: Option<&[u8]> = None;
    let mut type_id: [u64; MAX_TYPEID_LEN] = [0; MAX_TYPEID_LEN];
    let mut type_id_len: usize = 0;
    let mut type_annotation: Option<&[u8]> = None;

    // namespace: bstr at position 0
    if pos < buf.len() {
        let h = cbor::read_head(&buf[pos..]).map_err(Error::Cbor)?;
        if h.major == 2 {
            let (item, item_len) = cbor::read_definite_string(&buf[pos..]).map_err(Error::Cbor)?;
            local_namespace = Some(item);
            pos += item_len;

            // ns_annotation: tstr after namespace
            if pos < buf.len() {
                let h2 = cbor::read_head(&buf[pos..]).map_err(Error::Cbor)?;
                if h2.major == 3 {
                    let (item2, item_len2) =
                        cbor::read_definite_string(&buf[pos..]).map_err(Error::Cbor)?;
                    ns_annotation = Some(item2);
                    pos += item_len2;
                }
            }
        }
    }

    // typeId: consecutive uints
    while pos < buf.len() && type_id_len < MAX_TYPEID_LEN {
        let h = cbor::read_head(&buf[pos..]).map_err(Error::Cbor)?;
        if h.major == 0 {
            let (v, item_len) = cbor::read_uint(&buf[pos..]).map_err(Error::Cbor)?;
            type_id[type_id_len] = v;
            type_id_len += 1;
            pos += item_len;
        } else {
            break;
        }
    }

    // type_annotation: tstr after last typeId uint (only if at least one uint)
    if type_id_len > 0 && pos < buf.len() {
        let h = cbor::read_head(&buf[pos..]).map_err(Error::Cbor)?;
        if h.major == 3 {
            let (item, item_len) = cbor::read_definite_string(&buf[pos..]).map_err(Error::Cbor)?;
            type_annotation = Some(item);
            pos += item_len;
        }
    }

    // Skip any extra typeId uints beyond MAX_TYPEID_LEN to keep pos correct
    // for map/subrecord finding. The typeId is truncated for routing but the
    // parser still advances past all of them.
    while pos < buf.len() {
        let h = cbor::read_head(&buf[pos..]).map_err(Error::Cbor)?;
        if h.major == 0 {
            let (_v, item_len) = cbor::read_uint(&buf[pos..]).map_err(Error::Cbor)?;
            pos += item_len;
        } else {
            break;
        }
    }

    // Error: bare tstr with no namespace or typeId
    if local_namespace.is_none() && type_id_len == 0 {
        if pos < buf.len() {
            let h = cbor::read_head(&buf[pos..]).map_err(Error::Cbor)?;
            if h.major == 3 {
                return Err(Error::BareAnnotation);
            }
        }
    }

    // Map, if present
    let mut map_bytes: &[u8] = &[];
    if pos < buf.len() {
        let h = cbor::read_head(&buf[pos..]).map_err(Error::Cbor)?;
        if h.major == 5 {
            let item_len = cbor::skip_any_item(&buf[pos..]).map_err(Error::Cbor)?;
            map_bytes = &buf[pos..pos + item_len];
            pos += item_len;
        }
    }

    // Well-formedness check on map
    if !map_bytes.is_empty() {
        walk_map_pairs(map_bytes, |_k, _v| Ok(ControlFlow::Continue)).map_err(Error::Cbor)?;
    }

    // Everything remaining is subrecords
    let sub_bytes: Option<&[u8]> = if pos < buf.len() {
        Some(&buf[pos..])
    } else {
        None
    };

    Ok(Record {
        local_namespace,
        ns_annotation,
        type_id,
        type_id_len,
        type_annotation,
        map_bytes,
        sub_bytes,
    })
}

/// Applies the even/odd criticality rule (§3.2) to positive map keys only.
/// Key 0 (payload) and negative keys (common headers) are spec-reserved
/// and skipped. `on_ignored` is called per unrecognized odd key.
pub fn check_criticality(
    map_bytes: &[u8],
    known_keys: &[i64],
    mut on_ignored: impl FnMut(i64),
) -> Result<CriticalityOutcome, Error> {
    let mut aborted_on: Option<i64> = None;
    walk_map_pairs(map_bytes, |k, _v| {
        let value: Option<i64> = match k {
            cbor::Key::Uint(v) => {
                // Skip key 0 (payload) — spec-reserved
                if v == 0 {
                    return Ok(ControlFlow::Continue);
                }
                i64::try_from(v).ok()
            }
            cbor::Key::NegInt(_arg) => {
                // Skip negative keys (common headers) — spec-reserved
                return Ok(ControlFlow::Continue);
            }
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

pub fn find_value<'a>(map_bytes: &'a [u8], key: u64) -> Result<Option<&'a [u8]>, cbor::Error> {
    let mut found: Option<&'a [u8]> = None;
    walk_map_pairs(map_bytes, |k, v| {
        if let cbor::Key::Uint(k) = k {
            if k == key {
                found = Some(v);
                return Ok(ControlFlow::Stop);
            }
        }
        Ok(ControlFlow::Continue)
    })?;
    Ok(found)
}

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

pub fn read_definite_string(value_bytes: &[u8]) -> Result<&[u8], Error> {
    let (payload, _) = cbor::read_definite_string(value_bytes).map_err(Error::Cbor)?;
    Ok(payload)
}

pub fn read_uint(value_bytes: &[u8]) -> Result<u64, Error> {
    let (v, _) = cbor::read_uint(value_bytes).map_err(Error::Cbor)?;
    Ok(v)
}

pub use cbor::Key;

#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod tests;
