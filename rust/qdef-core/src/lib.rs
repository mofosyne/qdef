//! QDEF mandatory core: magic/version framing, CBOR-Sequence-of-Records
//! walking, key-0 routing, the even/odd criticality rule
//! (docs/QDEF-SPEC.md §2–§3.3). No knowledge of any specific Record Type,
//! no compression, no reassembly — those live in a separate stdlib layer,
//! not here, by design.
//!
//! `no_std`, zero heap allocation, zero dependencies (see `cbor` module for
//! why: this crate hand-rolls just enough CBOR to prove the "no
//! semantic-tag-aware CBOR library needed" claim is actually buildable on a
//! bare-metal target — see ../../docs/FINDINGS.md).
#![cfg_attr(not(test), no_std)]

mod cbor;

pub const MAGIC: [u8; 4] = *b"QDEF";
pub const VERSION: u8 = 1;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Error {
    TooShortForHeader,
    BadMagic,
    UnsupportedVersion(u8),
    Cbor(cbor::Error),
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum AbortReason {
    /// §3.1: a Record with no key 0 cannot be routed by any parser.
    MissingKeyZero,
    /// §3.1: the Smart-Route CBOR tag and the Constrained-Route key 0
    /// disagree about this Record's Type ID.
    HardwareParityMismatch { tag: u64, key0: u64 },
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

/// A parsed QDEF container: valid magic + supported version, wrapping the
/// CBOR Sequence of Records that follows.
pub struct Container<'a> {
    pub version: u8,
    seq: &'a [u8],
}

impl<'a> Container<'a> {
    pub fn parse(buf: &'a [u8]) -> Result<Self, Error> {
        if buf.len() < 5 {
            return Err(Error::TooShortForHeader);
        }
        if buf[0..4] != MAGIC {
            return Err(Error::BadMagic);
        }
        let version = buf[4];
        if version != VERSION {
            return Err(Error::UnsupportedVersion(version));
        }
        Ok(Container {
            version,
            seq: &buf[5..],
        })
    }

    pub fn records(&self) -> Records<'a> {
        Records {
            remaining: self.seq,
            done: false,
        }
    }
}

/// The NDEF path (§2): a bare CBOR Sequence with no magic/version prefix,
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
                // unlike a well-formed-but-unroutable Record (missing key 0,
                // tag mismatch), which aborts only itself. See FINDINGS.md:
                // the spec's "abort just that record" promise silently
                // assumes the record is at least well-formed CBOR.
                self.done = true;
                Some(Err(e))
            }
        }
    }
}

/// A routed Record: which Type ID it claims (via key 0), whether Hardware
/// Parity routing (§3.1) accepts it, and its raw map bytes for a
/// Record-Type-specific handler (e.g. `check_criticality`, `find_value`) to
/// inspect further.
pub struct Record<'a> {
    pub tag: Option<u64>,
    pub type_id: Option<u64>,
    pub aborted: bool,
    pub abort_reason: Option<AbortReason>,
    pub map_bytes: &'a [u8],
}

fn parse_record(buf: &[u8]) -> Result<(Record<'_>, usize), Error> {
    let head = cbor::read_head(buf).map_err(Error::Cbor)?;
    let (tag, map_start) = if head.major == 6 {
        (Some(head.arg), head.head_len)
    } else {
        (None, 0)
    };

    let (key0, map_len) = parse_map_key0(&buf[map_start..]).map_err(Error::Cbor)?;
    let total = map_start + map_len;
    let map_bytes = &buf[map_start..total];

    let (type_id, aborted, abort_reason) = match key0 {
        None => (None, true, Some(AbortReason::MissingKeyZero)),
        Some(id) => match tag {
            Some(t) if t != id => (
                Some(id),
                true,
                Some(AbortReason::HardwareParityMismatch { tag: t, key0: id }),
            ),
            _ => (Some(id), false, None),
        },
    };

    Ok((
        Record {
            tag,
            type_id,
            aborted,
            abort_reason,
            map_bytes,
        },
        total,
    ))
}

fn parse_map_key0(buf: &[u8]) -> Result<(Option<u64>, usize), cbor::Error> {
    let mut key0: Option<u64> = None;
    let consumed = walk_map_pairs(buf, |k, v| {
        if k == 0 && key0.is_none() {
            let (val, _) = cbor::read_uint(v)?;
            key0 = Some(val);
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
        if k != 0 && !known_keys.contains(&k) {
            if k % 2 == 0 {
                aborted_on = Some(k);
                return Ok(ControlFlow::Stop);
            }
            on_ignored(k);
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
        if k == key {
            found = Some(v);
            return Ok(ControlFlow::Stop);
        }
        Ok(ControlFlow::Continue)
    })
    .map_err(Error::Cbor)?;
    Ok(found)
}

/// Shared pair-walker used by key-0 routing, criticality checking, and
/// field lookup alike — one generic "walk a CBOR map's key/value pairs"
/// implementation instead of three near-duplicates. QDEF Record keys are
/// always uints (§3); a non-uint key is treated as malformed.
fn walk_map_pairs<'a>(
    map_bytes: &'a [u8],
    mut visit: impl FnMut(u64, &'a [u8]) -> Result<ControlFlow, cbor::Error>,
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

        let (key, klen) = cbor::read_uint(&map_bytes[pos..])?;
        pos += klen;
        let vstart = pos;
        let vlen = cbor::skip_value(&map_bytes[pos..], cbor::MAX_DEPTH)?;
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

#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod tests;
