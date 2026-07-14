//! Minimal, hand-rolled CBOR primitives — deliberately not a general CBOR
//! library. This is the actual object of the exercise: the QDEF spec claims
//! a "deeply constrained embedded scanner with no semantic-tag-aware CBOR
//! library" can implement the mandatory core (docs/QDEF-SPEC.md §3.3).
//! Pulling in a CBOR crate here would just re-test the Node prototype's
//! finding a second time; hand-rolling the byte-level decode is what tells
//! us whether that claim is actually true.
//!
//! Scope is deliberately narrow: read a head byte + argument, read a small
//! uint or a definite-length string, skip one *field value* (which, per
//! docs/QDEF-SPEC.md §3.2's field-value-shape rule, is never a bare
//! array/map/tag — keeping this O(1) without recursion), and skip an
//! *arbitrary* CBOR item (for walking unknown items in a Record's typeID
//! prefix). The field-value skip is recursion-free by construction; the
//! arbitrary-item skip uses a bounded explicit stack.

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Error {
    UnexpectedEof,
    ReservedAdditionalInfo,
    LengthOverflow,
    NotAUint,
    NotAMap,
    NotAString,
    /// A Record map key was neither a uint (major type 0) nor a byte
    /// string (major type 2) — all map keys in QDEF are uints.
    NotAKey,
    /// §3.2: a Record field's value was a bare array or map (major type 4
    /// or 5), an indefinite-length string, or a tag (major type 6) wrapping
    /// anything other than a definite-length string directly (including
    /// another tag) — none of which are legal QDEF field values. Structured
    /// content must be pre-encoded as CBOR and carried inside a
    /// definite-length byte string instead.
    DisallowedFieldValueShape,
    /// `skip_any_item` encountered a break byte outside any indefinite-
    /// length container.
    UnexpectedBreak,
    /// `skip_any_item` ran out of nesting depth (stack overflow guard).
    DepthOverflow,
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
/// (uint, negint, simple, or float), a definite-length byte/text string, or
/// any CBOR tag wrapping exactly one definite-length byte/text string
/// directly. Anything else that would require walking into nested
/// structure to find its length — a bare array, a nested map, an
/// indefinite-length string, or a tag wrapping anything other than a
/// string directly (including another tag) — is refused immediately
/// rather than walked, so this function still never recurses and never
/// loops: the tag branch is two fixed header reads in sequence, not a call
/// back into this function, so nesting a tag inside a tag is rejected
/// rather than silently accepted at unbounded depth, regardless of which
/// tag numbers are involved. That's the point: skipping an unrecognized
/// field stays O(1) instead of a stack-depth risk, tag included — the
/// *content* shape is what's checked, not the tag number, so this doesn't
/// need a tag allowlist to stay safe (spec §3.2, FINDINGS.md #15/#16).
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
        6 => {
            let rest = buf.get(head.head_len..).ok_or(Error::UnexpectedEof)?;
            let inner = read_head(rest)?;
            if (inner.major != 2 && inner.major != 3) || inner.is_indefinite() {
                return Err(Error::DisallowedFieldValueShape);
            }
            let inner_len = inner.arg as usize;
            let total = head
                .head_len
                .checked_add(inner.head_len)
                .and_then(|n| n.checked_add(inner_len))
                .ok_or(Error::LengthOverflow)?;
            if buf.len() < total {
                return Err(Error::UnexpectedEof);
            }
            Ok(total)
        }
        _ => Err(Error::DisallowedFieldValueShape),
    }
}

/// Skip any well-formed CBOR item, including containers (arrays, maps,
/// tags) and indefinite-length items. Uses a bounded explicit stack
/// instead of recursion — `no_std` safe, bounded at compile time.
///
/// This is used by the record-parsing loop to skip unknown items in a
/// Record's typeID prefix (forward-compat padding for future QDEF
/// evolution). The field-value shape rule (§3.2) does NOT apply here —
/// prefix items can be any valid CBOR.
pub(crate) fn skip_any_item(buf: &[u8]) -> Result<usize, Error> {
    const MAX_DEPTH: usize = 16;

    let mut pos = 0usize;
    // Stack: remaining items to process at each nesting depth.
    // u64::MAX is a sentinel for "inside an indefinite container".
    let mut stack = [0u64; MAX_DEPTH];
    let mut depth: usize = 0;
    stack[0] = 1; // start with 1 top-level item to process

    loop {
        if depth == 0 && stack[0] == 0 {
            break;
        }

        let head = read_head(&buf[pos..])?;
        pos += head.head_len;

        // Decrement: we just consumed one item at the current depth.
        // Must happen BEFORE any push so the new depth isn't affected.
        if stack[depth] != u64::MAX {
            stack[depth] -= 1;
        }

        match head.major {
            // uint or negint: head only
            0 | 1 => {}
            // simple or float (non-break): head only
            7 if head.info != 31 => {}
            // break: closes an indefinite container
            7 => {
                if depth == 0 {
                    return Err(Error::UnexpectedBreak);
                }
                stack[depth] = 0;
                // Pop completed levels — no decrement needed; parent was
                // already decremented when its head was read.
                while depth > 0 && stack[depth] == 0 {
                    depth -= 1;
                }
                continue;
            }
            // byte or text string: skip payload
            2 | 3 => {
                if head.is_indefinite() {
                    return Err(Error::UnexpectedEof); // no indefinite strings in QDEF prefix
                }
                let len = head.arg as usize;
                let total = head
                    .head_len
                    .checked_add(len)
                    .ok_or(Error::LengthOverflow)?;
                if buf.len() < total {
                    return Err(Error::UnexpectedEof);
                }
                pos += len;
            }
            // array
            4 => {
                if head.is_indefinite() {
                    if depth + 1 >= MAX_DEPTH {
                        return Err(Error::DepthOverflow);
                    }
                    depth += 1;
                    stack[depth] = u64::MAX; // sentinel: process until break
                } else if head.arg > 0 {
                    if depth + 1 >= MAX_DEPTH {
                        return Err(Error::DepthOverflow);
                    }
                    depth += 1;
                    stack[depth] = head.arg;
                }
                // arg == 0: empty array, nothing further to process
            }
            // map: 2× entries (key + value)
            5 => {
                if head.is_indefinite() {
                    if depth + 1 >= MAX_DEPTH {
                        return Err(Error::DepthOverflow);
                    }
                    depth += 1;
                    stack[depth] = u64::MAX;
                } else if head.arg > 0 {
                    if depth + 1 >= MAX_DEPTH {
                        return Err(Error::DepthOverflow);
                    }
                    depth += 1;
                    stack[depth] = head.arg.checked_mul(2).ok_or(Error::LengthOverflow)?;
                }
            }
            // tag: 1 inner item
            6 => {
                if depth + 1 >= MAX_DEPTH {
                    return Err(Error::DepthOverflow);
                }
                depth += 1;
                stack[depth] = 1;
            }
            _ => return Err(Error::ReservedAdditionalInfo),
        }

        // Pop completed levels — no decrement here; the parent was already
        // decremented when its head byte was read (lines 200-202).
        while depth > 0 && stack[depth] == 0 {
            depth -= 1;
        }
    }

    Ok(pos)
}

/// A Record map key: a uint, byte string, or text string (§3).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Key<'a> {
    Uint(u64),
    ByteString(&'a [u8]),
    TextString(&'a [u8]),
}

/// Reads a Record map key at `buf[0]`: a uint (major type 0), byte
/// string (major type 2), or text string (major type 3).
pub fn read_key<'a>(buf: &'a [u8]) -> Result<(Key<'a>, usize), Error> {
    let head = read_head(buf)?;
    match head.major {
        0 => Ok((Key::Uint(head.arg), head.head_len)),
        2 => {
            let len = head.arg as usize;
            let total = head
                .head_len
                .checked_add(len)
                .ok_or(Error::LengthOverflow)?;
            if buf.len() < total {
                return Err(Error::UnexpectedEof);
            }
            let payload = &buf[head.head_len..total];
            Ok((Key::ByteString(payload), total))
        }
        3 => {
            let len = head.arg as usize;
            let total = head
                .head_len
                .checked_add(len)
                .ok_or(Error::LengthOverflow)?;
            if buf.len() < total {
                return Err(Error::UnexpectedEof);
            }
            let payload = &buf[head.head_len..total];
            Ok((Key::TextString(payload), total))
        }
        _ => Err(Error::NotAKey),
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
