//! Minimal, hand-rolled CBOR primitives — deliberately not a general CBOR
//! library. This is the actual object of the exercise: the QDEF spec claims
//! a "deeply constrained embedded scanner with no semantic-tag-aware CBOR
//! library" can implement the mandatory core (docs/QDEF-SPEC.md §3.3).
//! Pulling in a CBOR crate here would just re-test the Node prototype's
//! finding a second time; hand-rolling the byte-level decode is what tells
//! us whether that claim is actually true.
//!
//! Scope: enough of CBOR (RFC 8949) to walk any well-formed item generically
//! (skip it, or read a small uint / definite-length string out of it) —
//! majors 0–7, definite AND indefinite lengths. No bignums, no float
//! interpretation beyond skipping their bytes. `no_std`, no heap.

/// Bounds worst-case recursion depth for `skip_value`. A malformed or
/// adversarial input with deeply nested arrays/maps/tags could otherwise
/// exhaust the stack on a small MCU — a concern that's invisible when a
/// hosted CBOR library (with a real stack, or its own depth guard) does the
/// walking for you, which is exactly why the Node prototype never surfaced
/// it. See ../FINDINGS.md.
pub const MAX_DEPTH: u8 = 16;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Error {
    UnexpectedEof,
    ReservedAdditionalInfo,
    UnexpectedBreak,
    LengthOverflow,
    TooDeep,
    NotAUint,
    NotAMap,
    NotATag,
    NotAString,
}

pub(crate) struct Head {
    pub major: u8,
    pub info: u8,
    /// Meaningful when `info` is 0..=27; undefined for indefinite (`info ==
    /// 31`) or break (major 7, info 31).
    pub arg: u64,
    /// Total bytes consumed by the head itself (initial byte + any
    /// following argument bytes), not including any payload.
    pub head_len: usize,
}

impl Head {
    #[inline]
    pub fn is_indefinite(&self) -> bool {
        self.info == 31
    }
}

pub(crate) fn read_head(buf: &[u8]) -> Result<Head, Error> {
    let b0 = *buf.first().ok_or(Error::UnexpectedEof)?;
    let major = b0 >> 5;
    let info = b0 & 0x1F;
    match info {
        0..=23 => Ok(Head {
            major,
            info,
            arg: info as u64,
            head_len: 1,
        }),
        24 => {
            let v = *buf.get(1).ok_or(Error::UnexpectedEof)?;
            Ok(Head {
                major,
                info,
                arg: v as u64,
                head_len: 2,
            })
        }
        25 => {
            let b = buf.get(1..3).ok_or(Error::UnexpectedEof)?;
            Ok(Head {
                major,
                info,
                arg: u16::from_be_bytes([b[0], b[1]]) as u64,
                head_len: 3,
            })
        }
        26 => {
            let b = buf.get(1..5).ok_or(Error::UnexpectedEof)?;
            Ok(Head {
                major,
                info,
                arg: u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as u64,
                head_len: 5,
            })
        }
        27 => {
            let b = buf.get(1..9).ok_or(Error::UnexpectedEof)?;
            let mut a = [0u8; 8];
            a.copy_from_slice(b);
            Ok(Head {
                major,
                info,
                arg: u64::from_be_bytes(a),
                head_len: 9,
            })
        }
        28..=30 => Err(Error::ReservedAdditionalInfo),
        31 => Ok(Head {
            major,
            info,
            arg: 0,
            head_len: 1,
        }),
        _ => unreachable!("5-bit field"),
    }
}

/// Skip one well-formed CBOR item starting at `buf[0]`, returning how many
/// bytes it occupied. Does not interpret the item's meaning beyond what's
/// needed to know its length — this is the building block that lets a
/// constrained parser walk past Record fields (or whole Records) it has no
/// schema for, without needing a full decode of their values.
pub(crate) fn skip_value(buf: &[u8], depth: u8) -> Result<usize, Error> {
    if depth == 0 {
        return Err(Error::TooDeep);
    }
    let head = read_head(buf)?;
    match head.major {
        0 | 1 => Ok(head.head_len),
        2 | 3 => skip_string(buf, &head, depth),
        4 => skip_items(buf, &head, depth, 1),
        5 => skip_items(buf, &head, depth, 2),
        6 => {
            let inner = skip_value(&buf[head.head_len..], depth - 1)?;
            Ok(head.head_len + inner)
        }
        7 => match head.info {
            31 => Err(Error::UnexpectedBreak),
            _ => Ok(head.head_len), // simple/float: head already carries any payload bytes
        },
        _ => unreachable!("3-bit major"),
    }
}

fn skip_string(buf: &[u8], head: &Head, depth: u8) -> Result<usize, Error> {
    if head.is_indefinite() {
        skip_until_break(buf, head.head_len, depth)
    } else {
        let len = head.arg as usize;
        let total = head
            .head_len
            .checked_add(len)
            .ok_or(Error::LengthOverflow)?;
        if buf.len() < total {
            return Err(Error::UnexpectedEof);
        }
        Ok(total)
    }
}

/// Skips `items_per_entry` (1 for arrays, 2 for maps: key+value) CBOR items
/// per logical entry, either `head.arg` times (definite) or until a break
/// byte (indefinite).
fn skip_items(buf: &[u8], head: &Head, depth: u8, items_per_entry: u8) -> Result<usize, Error> {
    let mut pos = head.head_len;
    if head.is_indefinite() {
        return skip_until_break(buf, pos, depth);
    }
    let entries = head.arg;
    for _ in 0..entries {
        for _ in 0..items_per_entry {
            pos += skip_value(&buf[pos..], depth - 1)?;
        }
    }
    Ok(pos)
}

fn skip_until_break(buf: &[u8], start: usize, depth: u8) -> Result<usize, Error> {
    let mut pos = start;
    loop {
        if *buf.get(pos).ok_or(Error::UnexpectedEof)? == 0xFF {
            return Ok(pos + 1);
        }
        pos += skip_value(&buf[pos..], depth - 1)?;
    }
}

/// Reads a definite-length unsigned integer (major type 0) at `buf[0]`.
pub(crate) fn read_uint(buf: &[u8]) -> Result<(u64, usize), Error> {
    let head = read_head(buf)?;
    if head.major != 0 {
        return Err(Error::NotAUint);
    }
    Ok((head.arg, head.head_len))
}

/// Reads a definite-length byte or text string (major type 2 or 3) at
/// `buf[0]`, returning the raw payload bytes and total bytes consumed.
/// Indefinite-length strings are out of scope for this helper (used only by
/// tests/field-extraction, not by the mandatory routing path).
pub(crate) fn read_definite_string(buf: &[u8]) -> Result<(&[u8], usize), Error> {
    let head = read_head(buf)?;
    if head.major != 2 && head.major != 3 {
        return Err(Error::NotAString);
    }
    if head.is_indefinite() {
        return Err(Error::NotAString);
    }
    let len = head.arg as usize;
    let total = head
        .head_len
        .checked_add(len)
        .ok_or(Error::LengthOverflow)?;
    let payload = buf.get(head.head_len..total).ok_or(Error::UnexpectedEof)?;
    Ok((payload, total))
}
