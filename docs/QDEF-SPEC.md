# QDEF — Quick Data Exchange Format

**Status: Draft. Validated by two throwaway prototypes — a Node round-trip
prototype covering the full design ([`/prototype`](../prototype)) and a
`no_std`, zero-dependency Rust prototype of the mandatory core specifically
([`/rust/qdef-core`](../rust/qdef-core)), which also builds for a bare-metal
Cortex-M0 target (see [FINDINGS.md](FINDINGS.md)); not yet implemented as a
reference library, not yet used in production anywhere. This document is
normative; the reasoning behind its decisions — mechanisms tried and
removed, alternatives weighed, and what's still unresolved — lives in
[DESIGN.md](DESIGN.md).**

QDEF is a general-purpose binary container for multi-action 2D barcodes
(QR, Data Matrix, Aztec) and NFC tags. Think of it as filling the gap NDEF
already fills for NFC — "here are one or more typed records in one
tap/scan" — but for the byte-mode payload of an optical code, or for an NFC
payload with no existing MIME type doing the routing. No equivalent exists
today: text barcode schemas (`WIFI:S:...;;`, `BEGIN:VCARD`) are rigid,
single-purpose, and text-only; NDEF solves multi-record framing but only
for NFC.

Without a format field to dispatch on, a general-purpose QR reader has no
choice but to *guess* what a scanned payload is — by sniffing prefixes, a
list that only grows and never gets more reliable. NDEF sidestepped this
for NFC decades ago with its MIME-type/TNF field; QR never had the
equivalent. QDEF's magic header plus prefix-based Type-ID routing (§3)
gives byte-mode QR that same explicit, extensible dispatch.

QDEF is meant to be adopted by unrelated applications with no shared
history — a Wi-Fi provisioning sticker, an event ticket, a passphrase-
protected key backup spread across several printed codes (worked example in
§7) are all equally valid uses. It is not tied to, and does not assume
familiarity with, any particular application.

## 1. Abstract & Philosophy

QDEF is binary-first: an extensible, multi-action CBOR payload, parseable
both by a modern smartphone and by a deeply constrained embedded scanner
(transit gate, POS terminal) with only a minimal CBOR decoder — no
semantic-tag support, no compression library, nothing beyond reading maps,
uints, and strings.

QDEF is deliberately two things, not one:

- A minimal **core format** (§3): magic framing, a self-delimited root
  Record, prefix-based Type-ID routing, and a per-key criticality
  rule. A parser that only implements this can route or skip any Record
  without knowing anything else about it.
- A separate, optional **standard library** (§4): reusable building blocks
  (splitting a payload across multiple codes, compression, encryption, a
  generic fallback) that any application can pull in without writing its
  own reassembly, cipher, or fallback-routing code.

Neither layer is optional to the *design* — see §4 for why a minimal
implementer must never be forced to bring a compression or reassembly
library just to route Records.

### When QDEF earns its place

Any application that already defines its own text/URI scheme (human-
typable, clickable — `myapp://...`) should encode its envelope directly
under that scheme, not wrap it in QDEF. The scheme prefix already does the
recognition job QDEF's magic header exists for (§2); wrapping adds only
redundant bytes with nothing to show for them. QDEF earns its place on
carriers with **no pre-existing dispatch**: plain byte-mode QR with no URI
at all, or an NDEF payload with no app-specific MIME type already routing
it. §7's PGP-key-backup example is exactly this case — those codes are only
ever scanned by one app, never clicked or typed, so there's no scheme to
lean on instead.

## 2. Container Wire Format

8-bit byte mode only — never alphanumeric; text-safety is explicitly not a
goal. A 4-byte magic header (4 bytes total, no version byte) for instant
optical-stream validation, followed directly by the **root Record** —
one self-delimited CBOR array (major type 4), the exact same shape as
any subrecord (§3), holding that Record's own
`namespace?`/`typeId*`/`map?`/`subrecord*` items. Self-
delimiting the root this way means any bytes appended after the
container are unambiguously outside it, by construction — no
end-of-buffer guesswork, no marker needed.

```
+----------------------+----------------------------------------------------+
|   Magic (4 bytes)     |     Root Record, one CBOR array (§3)                 |
+----------------------+----------------------------------------------------+
| 0x51 0x44 0x45 0x46   |  [ namespace?, typeId*, map?, sub* ]                |
|       "QDEF"          |  (self-delimited; anything after it is              |
|                        |   provably outside the container)                   |
+----------------------+----------------------------------------------------+
```

The root Record follows the same grammar as every other Record (§3):
an optional byte-string **namespace** (empty = inherit), then zero or
more consecutive uints forming the **typeId** sequence, then an
optional CBOR **map** (key `0` reserved for the payload), then
**subrecords**:

```
QDEF [100, {2: "SSID"}]                        -- typeId [100], no namespace
QDEF [h'deadbeef', 1, {0: "data"}]            -- namespace + type [1]
QDEF [[100, {2: "SSID"}], [200, {0: "data"}]]  -- Bundle (no typeId), two subrecords
QDEF [0, 10, {0: "https://..."}]               -- standard type [0, 10]
QDEF [h'deadbeef', 0, 10, {0: "..."}]         -- namespace ignored for standard type
```

Both the root array and every subrecord's own array header (its CBOR
element count) are what bound them — a decoder can always skip a whole
Record generically, using nothing but ordinary CBOR array-skipping,
without any Record-grammar knowledge at all.

For NFC, the magic prefix is redundant: NDEF's own MIME-type field already
identifies the payload. An NDEF record carrying QDEF content uses MIME type
`application/vnd.qdef` with the root Record's own self-delimited array as
the payload, no magic bytes.

**The same applies to an application carrying QDEF content under its own
URI scheme** (§1's "When QDEF earns its place"): the scheme prefix
(`myapp:...`) already identifies the payload, so the remainder is the
same self-delimited root array with no magic, decoded via the same
`decodeSequence` path.

**No version byte.** §3's even/odd criticality rule for map keys already
provides local forward compatibility.

**No record count or total payload size in the header.** The root
Record's own CBOR array is self-delimiting.

## 3. The Record Architecture

Every Record is exactly one definite-length CBOR array:

```
namespace?, ns_annotation?, typeId*, type_annotation?, map?, subrecord*
```

- **namespace** (optional): a CBOR **byte string** (major type 2) at
  position 0. Empty (`h''`) = inherit parent's. Absent = no scoping.
- **ns_annotation** (optional): a **text string** (major type 3)
  immediately after namespace — human-readable label, never load-bearing.
  Valid only after a namespace bstr.
- **typeId***: zero or more consecutive CBOR **uints** (major type 0).
  Leading uint `0` = standard QDEF type (§4) — always global. Leading
  uint > 0 = app type, scoped by namespace if present. Zero = Bundle.
- **type_annotation** (optional): a **text string** immediately after
  the last typeId uint — human-readable label, never load-bearing.
  Valid only after at least one uint.
- **map** (optional): first non-bstr, non-uint, non-tstr item, if a map
  (major 5), is the field Map. Key `0` = payload.
- **subrecord***: remaining items are nested Records.

A text string in any other position (e.g. position 0 with no preceding
bstr or uints) is a malformed Record — decoder MUST reject.

### Record shapes at a glance

| Wire shape | Typical use |
|---|---|
| `[ [ ... ], ... ]` | Bundle (no ns, no typeId) |
| `[h'ns', "n", [ ... ]]` | Bundle with namespace + annotation |
| `[N, { ... }]` | App type, no namespace |
| `[N, "name", { ... }]` | App type + type annotation |
| `[h'ns', "n", N, { ... }]` | Namespace + ns annotation + type |
| `[h'ns', N, "n", { ... }]` | Namespace + type + type annotation |
| `[0, N, { ... }]` | Standard type (global) |
| `[h'', N, { ... }]` | Inheriting parent's ns |

### Map key conventions

Same as website copy.

### 3.2 The Extensibility Rule (Even/Odd Keys)

Borrowed from PNG's critical/ancillary chunk convention. This rule
applies to **positive map keys only** — key `0` is spec-reserved for
payload and negative keys are spec-governed common headers (§3.6);
neither is governed by per-Type even/odd.

- **Even keys (> 0) are CRITICAL.** An unrecognized even-numbered key
  MUST cause the parser to abort processing *that record* (not the whole
  container — sibling records sharing the same array are unaffected).
- **Odd keys (> 0) are OPTIONAL.** An unrecognized odd-numbered key
  MUST be silently ignored; the rest of the record still processes
  normally.

This gives per-field forward compatibility: a future critical field
doesn't require any version-bump mechanism, only choosing an even key
number the current Record Type doesn't yet define.

**A Record field's value MAY be any well-formed CBOR item** — a scalar,
a string, or a nested array, map, or tag of any depth.

```
7: [1, 6, 11]                     // a bare array (major type 4)
```

Pre-encoding structured content as an opaque byte string is still
legal:

```
7: h'8301060b'                    // pre-encoded [1, 6, 11], opaque to a
                                   //   decoder that skips it
```

**Skip-safety.** `skip_any_item` walks containers of any shape with a
bounded explicit stack, never the call stack. Nesting depth is bounded
by each decoder's own practical limit.

**Advisory, not required.** Encoders SHOULD NOT produce field values
nested more deeply than genuinely useful content needs. Decoders MAY
enforce their own depth limit and reject anything deeper.

**Indefinite-length items are legal in field values for decoders to
accept, never for conformant encoders to produce** — §3.4's
canonical-encoding requirement (definite-length forms only) is
unchanged for encoders.

**Precondition on "the whole stream is unaffected":** this isolation
guarantee assumes the Record's own array is at least well-formed CBOR.
A Record with absent typeId (Bundle) or unrecognized typeId is still
well-formed CBOR and isolable — only that one Record is affected, never
its siblings. A Record whose own array is not even well-formed CBOR is
a stronger failure.

### 3.3 Conformance Levels

QDEF is designed so a minimal, generic parser is genuinely minimal — no
implementer has to bring a compression library or sector-reassembly logic
just to support the *container*:

- **Core QDEF parser (mandatory, all implementers):** verify magic, parse
  the root Record as one self-delimited CBOR array (§2/§3 — no
  separate discriminator to skip or interpret), read its typeId (and
  its subrecords' typeIds, recursively) to route or skip, apply the
  even/odd rule (§3.2) to unrecognized keys. That's the entire surface
  area — no compression, no multi-code state, no knowledge of any
  specific Record Type's fields.
- **Record-Type-specific handling (optional, per Record Type an implementer
  chooses to support):** everything else — including whether a given
  Record Type's payload happens to be compressed, or happens to require
  reassembling several codes — is defined *by that Record Type*, not by
  QDEF. An implementer who only cares about Wi-Fi provisioning (Type 100)
  never has to read, understand, or link against whatever some other
  registered Record Type does internally.

A conformant core parser never needs *true* recursion: every subrecord
is exactly one array, `typeId? → Map? → subrecord*`, and skipping any
well-formed CBOR item at any depth — an unrecognized field, a whole
unrecognized subrecord, or a whole subrecord's worth of its own
subrecords — uses a bounded explicit stack instead of the call stack.
A subrecord's own total byte span is always determined this same generic
way, before any attempt to interpret its contents.

### 3.4 Canonical Encoding

**Encoders MUST produce CBOR meeting RFC 8949 §4.2.1's core deterministic
encoding requirements** for every Record: the shortest-form argument for
every integer, length, and tag; no indefinite-length items; and every
Record Map's keys sorted in bytewise lexicographic order of their own
encoded bytes. QDEF doesn't define a new canonical-encoding rule — it
adopts CBOR's own, unchanged.

This is a requirement on *encoders*, not decoders: a decoder MUST NOT
reject an otherwise well-formed Record merely for being non-canonically
encoded (key order never affects whether `map[N]` is findable). The rule
exists so that anywhere QDEF hashes a Record's bytes for content-
addressing (§4.1's `group_id`, and any future Sign mechanism, §8), two
independent encoders handed identical field values compute the same
hash — otherwise semantically-identical content could hash differently
across encoders. See DESIGN.md for the full reasoning.

Not a new implementation burden in practice: most CBOR encoders already
default to shortest-form arguments and definite-length items. The one
requirement needing explicit encoder discipline is map key ordering —
cheap, since Record Maps are small by construction.

### 3.5 Namespace Scoping

A namespace is a byte string prefix on a Record, scoping its
non-standard typeIds. The namespace value is self-chosen — typically a
hash-derived value from a reverse-domain string, 4+ bytes long for
collision safety.

**Two special values:**
- **Empty byte string `h''`**: inherit the parent Record's namespace.
- **Absent (no bstr at position 0)**: no namespace.

**Standard types ignore namespace.** A typeId starting with `0` (e.g.
`[0, 10]`) is always global.

**Cascade.** A Record's namespace applies to its subrecords by default.
A subrecord uses `h''` to inherit, or declares its own explicit
namespace to override, or omits it entirely to opt out.

### 3.6 Reserved Map Keys

The field Map in every Record has two reserved key ranges, neither of
which is governed by per-Type even/odd criticality:

**Key `0` — Payload (RESERVED).** The Record's content payload. A
text string value is assumed plaintext; a byte string is opaque content
whose meaning is defined by the Record's own Type. Any other CBOR type
is also valid. A Bundle (no typeId) MUST NOT carry key `0`.

**Key `1` — Payload descriptor (RESERVED).** An optional hint
describing what key `0` holds — for example, a MIME type, URI scheme,
or human-readable label. Never load-bearing for routing; a decoder MUST
NOT rely on it for correctness. Key 0 and key 1 form a natural pair
(the data and its description) used by all standard types.

Keys 2+ are Type-specific, with even/odd criticality.

**Negative keys — QDEF Common Headers (spec-governed).** These are
few, spec-maintained only, and never self-allocatable by an
application:

```
+------+-----------------+--------------------------------------------+
| Key  | Name            | Value shape                                 |
+------+-----------------+--------------------------------------------+
|  -1  | ID              | bstr or tstr -- an NDEF-ID-equivalent       |
|      |                 | correlation token                           |
|  -3  | UUID            | bstr, exactly 16 bytes -- a standard        |
|      |                 | RFC 4122/9562 UUID, binary form only        |
+------+-----------------+--------------------------------------------+
```

**ID vs. UUID: two different jobs, not two shapes of the same field.**
ID is for correlating Records *within* the same scan/tap — cheap,
scoped, no uniqueness requirement. UUID is a stronger, standardized
identifier meant to survive outside the container entirely — tracking
a specific piece of content across scans, sessions, or systems. A Record
MAY carry either, both, or neither.

**A Type's own key `0` (payload) and the common `ID` key (`-1`) can
never collide** — CBOR's major-type distinction between non-negative
(major 0) and negative (major 1) integers keeps the two key spaces
disjoint.

All other keys are positive integers (`> 0`) governed by that Record
Type's own field numbering, with even/odd criticality (§3.2).

## 4. The QDEF Standard Record Types

QDEF is a *format plus a set of standard record types*, not just the
format — the same relationship C-the-language has with libc. §3 defines
a minimal core any conformant parser must implement, and says nothing
about compression, splitting, encryption, or graceful degradation for
scanners that don't understand a given Record Type. Those live here
instead: a small, curated set of Record Types any application can pull
in — writing no reassembly code, no cipher code, no fallback-routing
code of its own.

**Notation.** Throughout this section, `Type [0, N]: { ... }` is
shorthand for a standard Record Type's own array (§3):
`[0, N, { ... }]`. The brace-only form is used here purely for
readability; the wire shape is always the full array. When the field
Map is empty or absent, `{}` is omitted.

**Standard record type IDs** all share the `[0, N]` form — the leading
`0` marks them as QDEF-spec-standard. `N` values `2`–`98` are reserved;
`N = 0` is not used (Bundle has no typeId). Application types use `[N]`
(N > 0) for simple types or `[Ns, Nt]` for namespace-scoped types.

**Currently assigned type IDs**, each defined in its own subsection below:

```
+--------+------------------+---------+---------------------------------+
| TypeId | Record Type      | Section | Notes                          |
+--------+------------------+---------+---------------------------------+
| (none) | Bundle           | §4.6    | Structural grouping             |
| [1]    | Split            | §4.1    | Fragment reassembly / parity    |
| [2]    | Encrypt          | §4.1    | AEAD (e.g. AES-256-GCM)         |
| [3]    | Media Payload    | §4.3    | Typed binary content            |
| [4]    | Compress         | §4.1    | DEFLATE                         |
| [5]    | Open/Hint URI    | §4.2    | URI to open, or fallback        |
| [6]    | App Route        | §4.4    | Application dispatch/routing    |
| [7]    | Media Preview    | §4.5    | Content identification + body   |
| [8]    | Signature        | §4.7    | Detached authenticity           |
+--------+------------------+---------+---------------------------------+
```

All nine are global types (no namespace), spec-reserved in the 1–22
range.

**Type ID allocation ranges:**

```
+---------------------+---------------------------------------+--------+
| TypeId form         | Governance                            | Scope  |
+---------------------+---------------------------------------+--------+
| [N] (N 1-22)       | Standards Action — standard types     | global |
| [N] (N 23-98)      | Specification Required — reserved      | global |
| [N] (N 100-32767)  | Spec Required — reviewed app types     | global |
|                     |                                       | or ns  |
| [N] (N 32768+)     | First Come First Served — self-alloc   | global |
|                     |                                       | or ns  |
+---------------------+---------------------------------------+--------+
```

**Choosing a type ID form:**

```
1. Is this part of QDEF's own standard-record-type infrastructure?
     YES -> use assigned number 1-22, no namespace

2. Do you want eventual global recognition?
     YES -> [N] with N in 100-32767

     NO  -> [N] with N 32768+, optionally scoped by a
            self-chosen byte-string namespace (§3.5)
```

### 4.1 Wrapper Records (optional)

A **Wrapper Record** is an ordinary Record — same routing, same even/odd
rule — using a reserved low Type ID, whose payload is not application data
but the *encoded bytes of another Record* (which may itself be a Wrapper
Record, nested). Unwrapping and re-parsing the result as a Record is the
entire mechanism: no new parsing concept beyond "run the Record parser
again on these bytes." A single generic resolver — reassemble fragments /
decompress / decrypt, then re-parse as a Record, repeat until the result
isn't a Wrapper Record anymore — implements this for every Record Type
that opts in, with zero code written by that Record Type's own author
(demonstrated in `prototype/src/wrappers.js`'s `resolveStack`).

Wrapper Type IDs, authoritatively assigned by this spec document itself
(Standards Action, `0`–`22` — see the note above the Type ID allocation
table on why that tier needs no separate registry to be real):

```
Type [0, 2]:                     // Split
  // field map:
  0: h'<fragment bytes>',       // PAYLOAD: this code's slice (key 0)
  2: h'<group_id>',              // CRITICAL: content-addressed hash of the
                                  //   full reassembled bytes
  4: 1,                          // CRITICAL: this fragment's index
  6: 4,                          // CRITICAL: total fragment count
  7: 5821,                       // OPTIONAL (odd): total_bytes (MUST be
                                  //   present when key 9 is set)
  9: 1                           // OPTIONAL: parity_scheme

Type [0, 8]:                     // Compress (DEFLATE)
  // field map:
  0: h'<deflate bytes>'          // PAYLOAD: deflated bytes (key 0)

Type [0, 4]:                     // Encrypt (e.g. AES-GCM)
  // field map:
  0: h'<ciphertext+tag>',        // PAYLOAD: ciphertext + 16-byte GCM tag
  2: h'<nonce>',                 // CRITICAL
  3: 3,                          // OPTIONAL: Algorithm — 3 = A256GCM
  5: -25                         // OPTIONAL: Key Algorithm
```

**Keys `3` (Algorithm) and `5` (Key Algorithm)** are each a uint or a
text string, an encoder's choice:

- **A uint** is a [COSE Algorithm
  ID](https://www.iana.org/assignments/cose/cose.xhtml) (RFC 9053/9054),
  covering both content encryption algorithms (`1`/`2`/`3` =
  A128GCM/A192GCM/A256GCM) and key-agreement/wrap/derivation algorithms
  (`-25` = ECDH-ES+HKDF-256; `-10` = direct+HKDF-SHA-256; `-5` = A256KW)
  — negative integers included, permitted by §3.2.
- **A text string** names the algorithm directly for anything not
  registered there.

Both keys are odd/optional: absent, a decoder falls back to whatever
algorithm it already assumed, which fails safely either way since
AEAD's own authentication tag check catches a wrong-algorithm or
wrong-key attempt.

**A decoder that does honor key `3`/`5` MUST NOT let them broaden which
algorithms it's willing to run** — the same "alg" confusion class of
vulnerability JOSE/JWT is known for. Treat the field as a hint to check
against an application-chosen allowlist, never as an instruction to
trust outright.

**Encrypt cannot provide deniability — a scope boundary, not a gap.**
Being wrapped in a Type-`4` Record at all is itself a visible
declaration to any QDEF-aware parser, since Type ID routing (§3)
happens unconditionally before any per-Record-Type logic runs. An
application needing ciphertext indistinguishable from random should
keep its own encryption entirely inside an opaque registered blob (§5)
instead. See FINDINGS.md #13.

**Fragment chunking (Type 2).** The spec must fix *how* the original bytes
are sliced, not just what fields describe the result, or two independent
encoders/decoders can't agree on wire bytes. Fixed rule:

```
chunkLen = ceil(total_bytes / count)
fragment[i] = bytes[i * chunkLen .. min((i + 1) * chunkLen, total_bytes)]
```

the last fragment is shorter than `chunkLen` when `total_bytes` isn't an
exact multiple of `count`. This uniform-chunking rule is what makes
`parity_scheme`'s XOR-style recovery well-defined (every fragment
zero-padded to `chunkLen` before XOR). Splitting a group across
different-capacity physical codes with different-sized fragments while
still supporting parity recovery is not yet resolved — see §8.

`parity_scheme` mechanics: a parity fragment (index ≥ `count`, present
only when `parity_scheme` is set) is pure bonus redundancy — plain
reassembly only ever requires fragments `0` through `count − 1`. A
decoder that doesn't understand `parity_scheme` can ignore any fragment
past `count` and still reassemble correctly, losing only resilience,
never correctness. `parity_scheme = 1` (prototype-defined only): a
single XOR parity fragment, recovering exactly one missing/damaged
fragment.

**Fixed nesting order** when more than one Wrapper is combined: `Split
(outermost, if present) → Encrypt → Compress → plain inner Record`.
Compress-before-encrypt is the only sound order (ciphertext doesn't
meaningfully compress); Split-outermost is recommended for efficiency
but **not structurally required, and a decoder cannot detect or reject
a different order** — the generic resolver has no notion of "correct"
order. See FINDINGS.md #7.

**Why a wrapper, not a reserved key range on the inner record itself:**
wrapping avoids a cross-record correctness hazard. See DESIGN.md.

**Cost:** wrapper framing is added per code on top of the inner record,
so this stays strictly opt-in — a Record Type with no need for it stays
a plain, unwrapped Record.

### 4.2 Open/Hint URI (optional)

Unlike §4.1, this is deliberately **not** a wrapper — a plain standard record type Record
Type meant to sit as a *sibling* alongside real content records in the same
array, carrying a URI any generic tool can follow if it doesn't
understand anything else in the container. It's not exclusively a
fallback: the identical Record is also the right choice for a QR code
whose *entire* content is a single URI, with nothing else to fall back
from.

```
Type [0, 10]:                        // Open/Hint URI (standard record type)
  // field map:
  0: "https://example.com/open-this",  // PAYLOAD: URI (key 0)
  1: "Open in MyApp",                   // OPTIONAL: human-readable label
  3: "en",                              // OPTIONAL: BCP 47 language tag
  5: 0                                  // OPTIONAL: suggested action
}

This is what gives a QDEF container the "something useful happens even
without the specific app" property. It **must** stay a plain sibling
record, never nested inside a Wrapper.

**Keys `3` and `5`** are odd/optional (§3.2): key `3` a BCP 47 language
tag for key `1`'s label, key `5` a suggested action.

**Multiple languages or URIs need no new mechanism** — repeat Open/Hint
URI as an ordinary sibling Record, once per variant.

### 4.3 Media Payload (optional)

A plain standard record type Record Type — not a wrapper — for attaching a standard,
already-widely-recognized media type (a JPEG thumbnail, a vCard, a PDF
snippet) without registering a bespoke Type ID for every possible file
format the way [EXAMPLES.md](EXAMPLES.md) does for application-specific content:

```
Type 6:                           // Media Payload (standard record type)
  // field map:
  0: h'<content bytes>',          // PAYLOAD: the content itself (key 0)
  1: 22                           // OPTIONAL: Media Type — uint or text
```

**Key `1` (Media Type) may be a uint or a text string** — an encoder's
choice, and a decoder MUST accept either shape:

- **A uint in `0`–`65535`** is a [CoAP Content-Format
  ID](https://www.iana.org/assignments/core-parameters/core-parameters.xhtml)
  (RFC 7252 §12.3, as amended by RFC 9876) — an existing IANA registry
  assigning compact numeric IDs to common media types (`application/cbor`
  = 60, `image/jpeg` = 22, `image/png` = 23, `application/json` = 50,
  `text/plain;charset=utf-8` = 0, and hundreds more).
- **A text string** is the literal MIME type, used whenever the media
  type isn't in CoAP's registry (e.g. `"text/vcard"`).

Adopters relying on this field SHOULD keep a periodic mirror of CoAP's
Content-Formats table, so the numbering can be kept alive independently
if that registry ever goes unmaintained. See DESIGN.md.

Prototyped in `prototype/test/media-payload.test.js`.

### 4.4 App Route (optional)

A plain standard record type Record — not a wrapper — for letting a generic
QDEF-aware scanner offer to launch a specific handling application,
comparable to NFC's Android Application Record (AAR) or platform
Intent-filter dispatch, without the scanner needing any
implementer-specific knowledge baked in ([GitHub issue
#10](https://github.com/mofosyne/qdef/issues/10)):

```
Type [0, 12]:                       // App Route — domain form
  // field map:
  0: "example.com",                 // PAYLOAD: domain (key 0)
  1: "Open in Example App"          // OPTIONAL: human-readable label

Type [0, 12]:                       // App Route — hash-derived form
  // field map:
  0: h'<truncated SHA-256>',        // PAYLOAD: hash-derived byte string
  1: "com.example/tagdrop-paper"    // OPTIONAL: Hint name
```

**Key `0` may be a domain string or a hash-derived byte string — two
different trust models for two different purposes.**

*The domain form* is verifiable using the mechanism Android App Links
and iOS Universal Links already deploy (a `.well-known` file —
`assetlinks.json` on Android, `apple-app-site-association` on iOS —
hosted on the domain the claimant controls). Use this form for
auto-launch dispatch, where getting it wrong means the wrong
application opens.

*The hash-derived form* uses a hash-derivation algorithm (SHA-256 over
the name's UTF-8 bytes, truncated to the developer's chosen length) to
produce key `0`'s value, with key `1` playing the Hint name role. This
is a plain field value, not a Type ID — App Route's own routing typeId
is always the standard uint `12` either way. **This form has no
anti-spoofing property.** The hash-derivation proves name-to-value
consistency, never authorization — anyone can compute the same hash
from the same name. Use this form only where getting it wrong costs
*effort*, not *trust*: a fast, per-code pre-filter a scanner uses to
reject an obviously-unrelated scan before attempting reassembly,
layered ahead of §4.1's `group_id` integrity check, never as a
replacement for it.

Resolving a domain to a launch target is platform-specific:

- **Android** exposes an explicit query (`PackageManager` Intent-filter
  resolution) a scanner can call to ask "which installed app claims
  this domain."
- **iOS** exposes no equivalent query. A scanner constructs an actual
  `https://` URL from the domain and opens it (`openURL:`); iOS checks
  the domain's `apple-app-site-association` registration as a side
  effect of opening that URL.

Key `0` carries the bare domain, not a full URL.

**Not positionally special** — a decoder finds this Record the same way
it finds any recognized Record Type (§3).

**Encoder etiquette, repetition across a multi-code group:**

- *The domain form* SHOULD repeat verbatim on every code if the adopter
  wants auto-launch to work from whichever code is scanned first.
  Restricting it to one designated code is also valid; auto-launch then
  only fires from that code.
- *The hash-derived form* SHOULD repeat on every code, more strongly
  than the domain form — its entire value is rejecting an
  obviously-unrelated scan *before* reassembly, which a copy on only
  one code can't do for scans of any other code in the group.

Both forms SHOULD stay small and plain — never Compress- or
Split-wrapped — so a scanner can read one without reassembling anything
else first. See DESIGN.md for the per-code-repetition cost tradeoff
between the two forms.

### 4.5 Media Preview (optional)

A plain standard record type Record — not a wrapper — for identifying a
content item (media type, content hash, filename, human-readable label)
independently of the content bytes themselves, which travel as this
Record's own subrecord (§3):

```
Type [0, 14]:                       // Media Preview (standard record type)
  // field map:
  // (no key 0 — no payload; content travels as subrecord)
  2: "image/png",                   // CRITICAL: IANA media type
  3: h'12<digest>',                 // OPTIONAL: multihash-style content hash
  5: "photo.png",                   // OPTIONAL: filename or slug
  7: "Trail photo"                  // OPTIONAL: human-readable label
}
```

**Key `3` is a multihash-style value, not raw SHA-256** (and not §3.5's
name-string derivation, despite both being hash-based -- different
input, different purpose): a 1-byte hash-function code from the
[multiformats multicodec
table](https://github.com/multiformats/multicodec/blob/master/table.csv)
(`0x12` = sha2-256), followed by the digest, truncated or full, with no
separate length field of its own -- the digest's length is exactly
however many bytes remain after the function-code byte, since this
whole value is already a length-delimited CBOR byte string (major type
2). This differs from canonical multiformats multihash (which also
carries its own length as a second varint byte) only by omitting that
redundant field; recovering a byte-identical canonical multihash from
this value is a one-byte insertion (the digest's own length, itself
after the function code), not a reinterpretation. Identifies the
content independently of any label, and lets an application choose a
different hash function without QDEF needing a new key for it --
borrowing an external registry for algorithm-agility inside one field,
the same pattern §4.1's Encrypt uses for its own Algorithm field (key
`3`, COSE's registry) rather than QDEF inventing its own. Adopters
relying on this field SHOULD keep a periodic mirror of the multicodec
table, the same caution as §4.3's CoAP Content-Formats note.

The identified content itself is carried as a subrecord, typically a
§4.3 Media Payload:

```
[ 0, 14, { 2: "image/png", 3: h'...', 5: "photo.png" },
  [ 0, 6, { 0: h'<payload bytes>', 2: "image/png" } ] ]
```

**Why not put identification fields on Media Payload's own map?** §4.3
deliberately stays minimal (media type + bytes, nothing else) so it
stays usable standalone wherever identification isn't needed. Media
Preview adds the identification layer as a separate, composable Record
instead of growing Media Payload's own field set.

**When Split is present, Split MUST be outermost, with Media Preview as
its subrecord** — not the reverse. A decoder that doesn't recognize `[0, 14]`
(critical): a decoder that doesn't recognize Type 14 aborts on that
whole Record, including anything nested inside it. If Media Preview
wrapped Split instead, an old Split-only decoder that has never heard
of Media Preview would lose the ability to reassemble the fragment
group at all. With Split outermost, that same old decoder just skips
the unrecognized Media Preview subrecord (§3.2) and reassembles
correctly regardless:

```
[ 0, 2, { 0: h'<fragment 0>', 2: h'<group_id>', 4: 0, 6: 3, 7: 9 },
  [ 0, 14, { 2: "image/png", 3: h'...', 5: "photo.png" } ] ]
```

Identification fields repeat on every code in the group, the same as
any other per-code metadata (§4.4's encoder-etiquette note applies
here too).

Prototyped in `prototype/test/media-preview.test.js`.

### 4.6 Bundle (structural)

A **Bundle** is a structural Record — not a wrapper, not application
data — for grouping related Records together as subrecords. It has no
typeId (absent), no payload (no key 0), and no field Map of its own.
Its meaning is entirely in its subrecords:

```
[]                              // Empty Bundle (container root, no subrecords)
[[100, {2: "SSID"}], [0, 10, ...]] // Bundle with two subrecords
```

The container root is implicitly a Bundle whenever its array leads with
no uints (§2). An explicit Bundle subrecord exists for grouping Records
one level down, which a generic tool can recognize and skip as a unit
without inspecting each subrecord's typeId.

A decoder that doesn't recognize Bundle (no standard-type knowledge)
skips the entire array generically via ordinary array-skipping — the
same as any unrecognized Record.

Prototyped in `prototype/test/bundle.test.js`: round-trip with the
empty map omitted, an unaware decoder skipping the whole Bundle (and
its subrecords) by Type ID alone, the namespace-scoping claim above
verified against `header.js`'s `resolveLookupKeysDeep`, and the hint/
backup keys degrading gracefully for a decoder that doesn't recognize
them.

### 4.7 Signature (optional)

A **Signature** is a sibling Record providing detached authenticity: it
covers Records around it without wrapping or hiding them, so they stay
plain and readable to a decoder that doesn't recognize Type 16 at all.
Coverage is positional, not hash-based — a Signature Record covers
every Record immediately preceding it **within the same array** (the
root array, or a shared parent's own subrecord list), since the
start of that array or the previous Signature Record within it,
whichever is nearer. It never covers a Record at a different nesting
level, its own parent's map or payload, or anything that follows it:

```
Type [0, 16]:                      // Signature (standard record type)
  // field map:
  0: h'<signature bytes>',         // PAYLOAD: signature over the covered
                                     //   Records' own canonical bytes (key 0)
  2: -8,                           // CRITICAL: Algorithm — a COSE Algorithm
                                     //   ID (IANA registry, RFC 9053); -8 = EdDSA
  4: h'<32-byte public key>'       // CRITICAL: Public Key — raw bytes
```

Unlike Encrypt's Algorithm field (§4.1, key `3`, odd/optional — a
missing or wrong guess fails safely because AEAD's own authentication
tag catches it), Signature's Algorithm is **critical (even)**: there is
no equivalent fallback for verification, so a decoder that doesn't
understand the stated algorithm MUST abort rather than guess.

**The signed message is the concatenation of the covered Records' own
canonical bytes (§3.4), in wire order — no coverage list, no extra
framing.** Because CBOR items are self-delimiting and covered Records
already sit contiguously in the array, this is a direct byte range on
the wire, not a reconstruction: a decoder recomputes it by re-encoding
each covered Record from its parsed form and concatenating the results,
the same canonical-encoding reliance `group_id` (§4.1) already requires.

**A decoder that does recognize Type 16 MUST NOT let Algorithm broaden
which algorithms it's willing to run** — the same allowlist discipline
as Encrypt's key `3`/`5` (§4.1).

**Cost and scope, by design, not omission.** Zero coverage-
identification bytes — cheaper than a hash-list sibling form — at the
cost of the same reordering/insertion fragility any positional scheme
carries: inserting, removing, or reordering a Record between the
checkpoint and the Signature Record invalidates it, even if that change
is otherwise unrelated. Scoping coverage to "same array" also bounds
that fragility's blast radius to one list (the root array, or
one parent's subrecords) rather than the whole container, and confines
what a Signature Record can cover to Records sharing one immediate
context — it cannot reach an arbitrary cross-tree group of Records with
no common parent. A Signature nested inside a Bundle (§4.6) covers only
that Bundle's own subrecords.

This is a strippable-but-not-forgeable design: deleting a Signature
Record downgrades signed content to unsigned trivially, an accepted
property, not a gap — the same way NFC Forum's own Signature RTD
(position-since-checkpoint over a flat NDEF message, the same rule
applied here, generalized to any array) accepts it.

Prototyped in `prototype/test/signature.test.js`: signing and verifying
top-level Records, a reordered or tampered covered Record failing
verification, an unrelated inserted Record failing verification, an
unaware decoder skipping the whole Record by Type ID alone, a Signature
nested inside a Bundle covering only that Bundle's own subrecords, two
Signature Records in the same list checkpointing independently of each
other, and both even/odd criticality and an unsupported Algorithm value
being reported rather than silently accepted. Ed25519 (COSE Algorithm
`-8`) is the only algorithm this prototype implements; the Algorithm
field itself is wire-compatible with adding others later.

## 5. Adopting QDEF for an existing application-specific format

An application with its own existing binary payload format (e.g. a
proprietary CBOR sequence used today for some other transport) can register
one Record Type ID and carry that payload unchanged, byte-for-byte, as an
opaque blob under a single key:

```
[ N, {
  0: h'<existing payload bytes>'  // CRITICAL: raw bytes, unchanged from
                                   //   whatever that application already
                                   //   defines — QDEF never looks inside
} ]
```

This lets a QDEF-aware scanner dispatch a single byte-mode QR or NFC tag
containing, say, a Wi-Fi Record *and* this application's own content Record
together — without that application's own decoder changing at all: it
still just reads the raw bytes out of key `0`. This is additive and
opt-in — nothing about the application's own format needs to route through
QDEF for it to keep working exactly as it does today.

(`mofosyne/tagdrop` uses exactly this pattern, illustrated here as Type
`900`; §7 below is an unrelated adopter using the same mechanism.)

**Registering a real Type ID before governance exists.** `900` here is
an illustrative placeholder, not a protected allocation — the
`100`–`32767` tier has no review authority yet. Any adopter wiring this
into real shipping code before that governance exists should declare
their own namespace (§3.5) and use a namespace-scoped odd uint instead
of a fixed low number in the shared tier — cheaper, and no Type ID to
migrate later.

**On signing:** an adopter whose own signature covers the
fully-reassembled plaintext (after all splitting/addressing is
resolved) needs no QDEF-level Sign mechanism — §4.1's `group_id` is
already a content hash a decoder MUST verify after Split reassembly,
which is all a whole-payload signature needs from the container. See §6
and DESIGN.md.

## 6. Compression and splitting across multiple tags/codes

**QDEF itself defines neither** — both stay entirely inside each Record
Type's own payload definition. An application that already solved
reassembly/compression for its own format keeps using its own solution,
unchanged, rather than adopting a second, competing one at the QDEF layer.
See [DESIGN.md](DESIGN.md#why-not-build-compression-or-splitting-into-the-container)
for why these were deliberately kept out of the container.

**The same reasoning applies to signing.** An application with its own
proven authentication mechanism over the fully reassembled payload needs
no QDEF Sign primitive either (§5). §8's Sign entry is for the different
case — a Record with no pre-existing answer of its own.

**If an application wants splitting, compression, or encryption without
writing any of it itself:** that's what §4.1's Wrapper Records are for — a
generic, reusable resolver any Record Type can opt into by simply being
wrapped, with zero code written by that Record Type's own author (§7 is the
worked example).

## 7. Worked example: passphrase-protected key backup across several codes

An app backs up a passphrase-protected secret key across a set of printed
QR codes. This app has **no scheme of its own** to dispatch on — these
codes are only ever scanned by its own app, never clicked or typed — so per
"When QDEF earns its place" (§1), going through QDEF's byte-mode container
(magic header included) is the right call.

Registers one Record Type, say `[950]`, for the plain secret-key bytes:

```
[950, {0: h'<raw secret key packet bytes>'}]   // typeId [950], payload at key 0
```

Because the key material is sensitive and may not fit one code, the app
composes it through two Wrapper Records, in the recommended order from
§4.1 — `Split (outermost) → Encrypt → plain [950] Record` (no `Compress`
layer here — key material is already high-entropy, DEFLATE wouldn't help):

```
authoring:  [950] Record  →  Encrypt [0, 4]  →  Split [0, 2]
decoding:   Split [0, 2]  →  Encrypt [0, 4]  →  [950] Record
            (per code)       (after reassembly)    (the real key)
```

Each printed code carries one Split-Wrapper Record (Type 2) with
`parity_scheme` set — losing one code out of the set is recoverable, which
matters far more for a one-off secret-key backup than for disposable
content. The app wrote **zero** reassembly, parity, or AES-GCM code of its
own for the container format — all of it is the shared QDEF Wrapper
resolver from §4.1, exercised through the exact same recursive "unwrap
bytes → re-parse as a Record" step, regardless of what Type 950 turns out
to mean. This is exactly the case Encrypt's Algorithm/Key Algorithm fields
(§4.1) are optional for: the app's own passphrase-KDF scheme is only ever
read by itself, so it has nothing to gain from self-describing it — those
fields exist for the *different* case of two unrelated apps needing to
interoperate on a key transfer, not this one.

This exact scenario — 3 data fragments + 1 XOR parity fragment, one
fragment deliberately dropped and recovered, then the full
Split→Encrypt→plain chain decrypted and re-parsed — is exercised end to end
in `prototype/test/roundtrip.test.js`.

## 8. Design rationale and open questions

Moved to [`DESIGN.md`](DESIGN.md): why mechanisms were removed (the CBOR
tag route), alternatives weighed and
rejected, comparisons against NDEF/BBQr/MCAP and `mofosyne/tagdrop`, and
what this draft still hasn't resolved (registry governance, the Sign
wrapper, Split's per-code capacity limits). None of it is required
reading to implement a conformant parser — everything normative is
above this line.
