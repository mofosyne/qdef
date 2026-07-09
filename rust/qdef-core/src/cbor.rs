//! Minimal, hand-rolled CBOR primitives — deliberately not a general CBOR
//! library. This is the actual object of the exercise: the QDEF spec claims
//! a "deeply constrained embedded scanner with no semantic-tag-aware CBOR
//! library" can implement the mandatory core (docs/QDEF-SPEC.md §3.3).
//! Pulling in a CBOR crate here would just re-test the Node prototype's
//! finding a second time; hand-rolling the byte-level decode is what tells
//! us whether that claim is actually true.
//!
//! Scope is deliberately narrow: read a head byte + argument, read a small
//! uint or a definite-length string, and skip one *field value* — which,
//! per docs/QDEF-SPEC.md §3.2's field-value-shape rule, is never an array,
//! map, or tag. That rule is what keeps this module free of recursion
//! entirely, not just bounded — see `skip_value` below and ../FINDINGS.md.

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Error {
    UnexpectedEof,
    ReservedAdditionalInfo,
    LengthOverflow,
    NotAUint,
    NotAMap,
    NotAString,
    /// §3.2: a Record field's value was a bare array, map, or tag (major
    /// type 4, 5, or 6), or an indefinite-length string — none of which are
    /// legal QDEF field values. Structured content must be pre-encoded as
    /// CBOR and carried inside a definite-length byte string instead.
    DisallowedFieldValueShape,
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

/// Skip one CBOR item that is a legal QDEF Record field value: a scalar
/// (uint, negint, simple, or float) or a definite-length byte/text string.
/// Anything that would require walking into nested structure to find its
/// length — a bare array, a nested map, a tag, or an indefinite-length
/// string — is refused immediately rather than walked, so this function
/// can never recurse and never loops. That's the point: it's what makes
/// skipping an unrecognized field O(1) instead of a stack-depth risk.
pub(crate) fn skip_value(buf: &[u8]) -> Result<usize, Error> {
    let head = read_head(buf)?;
    match head.major {
        0 | 1 => Ok(head.head_len),
        7 if head.info != 31 => Ok(head.head_len),
        2 | 3 if !head.is_indefinite() => {
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
        _ => Err(Error::DisallowedFieldValueShape),
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
