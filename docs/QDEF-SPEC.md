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
choice but to *guess* what a scanned payload is — is this a URL? a `WIFI:`
string? a vCard? raw text? — by sniffing prefixes. Every new payload type
it wants to recognize is one more heuristic bolted onto that guesswork, a
list that only grows and never gets more reliable, because nothing in the
payload itself ever says what it is. NDEF sidestepped this for NFC decades
ago with its MIME-type/TNF field; QR never had the equivalent, so readers
inherited the sniffing problem instead. QDEF's magic header plus prefix-based Type-ID routing (§3) gives byte-mode
QR that same explicit, extensible dispatch — a reader checks a few prefix
items instead of accumulating heuristics.

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

- A minimal **core format** (§3): magic framing, a CBOR Sequence of
  Records, prefix-based Type-ID routing, and a per-key criticality
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
optical-stream validation, followed by a **mandatory container
discriminator** (§3.5 — always exactly one CBOR item, always present),
followed by a CBOR Sequence (RFC 8742) of Records — a sequence rather
than a wrapping CBOR array, so a constrained parser can process each
Record as it streams in without buffering the whole payload first
(validated in the prototype against a real incremental CBOR decoder fed
arbitrary byte chunks).

```
+----------------------+------------------------+----------------------------------+
|   Magic (4 bytes)     | Discriminator (1 item) |     CBOR Sequence of Records     |
+----------------------+------------------------+----------------------------------+
| 0x51 0x44 0x45 0x46   |  uint, bstr, array,    |  Record, Record, Record, ...     |
|       "QDEF"          |  or map (§3.5)         |                                  |
+----------------------+------------------------+----------------------------------+
```

A minimal Record is at minimum a typeID prefix (uint or byte string) followed
by a flat field Map:

```
+---------------------------+-------------------------------+
|  typeID prefix (1+ items) |   field Map (CBOR map)        |
+---------------------------+-------------------------------+
|  100                      |  { 0: "SSID", 2: 2 }         |
+---------------------------+-------------------------------+
```

The map acts as the record delimiter in the Sequence — the parser knows a
Record ends when it reaches the first Map. Additional prefix items may
follow the primary typeID (backup IDs for transitional routing, §3.1), and
unknown items may appear between typeIDs and the map (forward-compat
padding for future QDEF evolution), but the minimum viable Record is just
typeID + map.

For NFC, the magic prefix is redundant: NDEF's own MIME-type field already
identifies the payload. An NDEF record carrying QDEF content uses MIME type
`application/vnd.qdef` with just the CBOR Sequence of Records as the
payload — no magic bytes, and no discriminator item either, since NDEF's
MIME type already provides the "what kind of file is this" identification
the discriminator otherwise exists to buy (§3.5). The magic-and-
discriminator header exists only for the QR/optical case, where a scanner
needs to recognize the byte stream's format before any higher-level
dispatch exists to tell it what it's looking at. (Validated in the
prototype: a bare CBOR Sequence with no magic prefix and no discriminator
decodes through the exact same Record-routing logic as the full
container.)

**The same is true for an application carrying QDEF content under its own
URI scheme** (§1's "When QDEF earns its place"): the scheme prefix
(`myapp:...`) already told the reader what it's looking at before any
QDEF-specific parsing begins, doing the identical dispatch job magic *and*
the discriminator exist to provide for an otherwise-unidentified byte-mode
stream — a scanner recognizes `myapp:` and hands the remainder straight to
that app's own decoder. The remainder is a bare CBOR Sequence of Records
with no magic and no discriminator, decoded exactly the same way as the
NDEF case above, via the same `decodeSequence` path. `mofosyne/tagdrop`'s
own `tagdrop:<...>` scheme already does exactly this dispatch job for its
own wire format today; an application in that position pays no
magic-byte or discriminator-byte cost at all for adopting QDEF's Record
shape underneath its existing scheme. (Validated in the prototype:
`prototype/test/custom-scheme-carrier.test.js`.) This dispatch-based
isolation is what §3.5's even-Type-ID guidance leans on for collision
safety — see that section's caution on why the same bytes reaching a
second, unisolated carrier (e.g. a shared MIME type, or a raw byte-mode
form with no distinguishing wrapper) silently forfeits it.

**No version byte.** §3.2's even/odd criticality rule already provides
local forward compatibility; see [DESIGN.md](DESIGN.md#container-framing-choices)
for why an earlier draft's version byte was removed.

**No record count or total payload size in the header.** A CBOR Sequence
is self-delimiting; see [DESIGN.md](DESIGN.md#container-framing-choices)
for why these fields were deliberately left out.

## 3. The Record Architecture

Every Record is a sequence of CBOR items terminated by a CBOR Map — one or
more typeID prefix items (uint or byte string), zero or more unknown items
(forward-compat padding for future QDEF evolution), then a flat field Map
as the record delimiter. Using a Wi-Fi Record (Type `100`, see
[EXAMPLES.md](EXAMPLES.md)) as the
example (this is where §3.2's even/odd rule and field-value-shape rule
apply — the "Type" column below is never array, map, or tag, by that
rule):

```
Prefix: 100                                  // typeID (uint 100)

Map:
+-----+------------------------+-------+----------+-----------------------------+
| Key | Value                  | Type  | Even/Odd | If unrecognized             |
+-----+------------------------+-------+----------+-----------------------------+
| 0   | "My Coffee Shop"       | text  | even     | CRITICAL: abort Record      |
| 2   | "guest123"             | text  | even     | CRITICAL: abort Record      |
| 4   | 2                      | uint  | even     | CRITICAL: abort Record      |
| 1   | true                   | bool  | odd      | OPTIONAL: silently ignored  |
+-----+------------------------+-------+----------+-----------------------------+
```

Every Record — a plain content Record like this one or a standard record
type Wrapper Record (§4.1) — has exactly this shape: prefix typeIDs
followed by a flat Map, and field values that are always scalar-or-string,
never structure to walk into. That fixed shape is what §3.3 means by "a
conformant core parser never needs recursion at all."

The parser uses a two-phase loop to find each Record's boundaries:
Phase 1 accumulates contiguous typeID items (uint, byte string, or text
string) at the start of the Record. Phase 2 skips any non-map items (forward-compat
padding) until it reaches the first Map, which serves as the record
delimiter.

### 3.1 Record Type ID (prefix items) and Backup Type IDs

Every Record begins with one or more typeID prefix items — a contiguous
run of uint (major type 0) or byte string (major type 2) items at the
start of the Record, before the field Map. The first typeID is the
*primary* routing key; any subsequent typeIDs are *backup* IDs carried for
transitional routing (see below).

The parser reads these prefix items to decide what kind of Record it's
looking at, or to skip a Record it doesn't recognize. A Record with no
typeID prefix items before the map cannot be routed at all and MUST be
marked as ignored (§3.2's well-formed-but-unroutable case).

The primary typeID's CBOR major type determines its classification:

```
+------------------+-------------------+------------------+-----------------------+
| typeID CBOR type | Classification    | Scope            | Meaning               |
+------------------+-------------------+------------------+-----------------------+
| uint, even       | Standard record   | Always global    | Registered standard   |
|                  | type              |                  | mechanism or content  |
|                  |                   |                  | type                  |
+------------------+-------------------+------------------+-----------------------+
| uint, odd        | Scoped record     | Namespace-       | REQUIRES a declared   |
|                  | type              | scoped           | namespace (§3.5);     |
|                  |                   |                  | absent namespace,     |
|                  |                   |                  | Record MUST abort     |
+------------------+-------------------+------------------+-----------------------+
| byte string      | Decentralized/    | Always global    | Developer-chosen ID;  |
| (major type 2)   | random ID         |                  | byte length is the    |
|                  |                   |                  | truncation choice     |
+------------------+-------------------+------------------+-----------------------+
| text string      | Named ID          | Always global    | Human-readable ID;    |
| (major type 3)   | (reserved for     |                  | collision safety from |
|                  | future use)       |                  | name uniqueness       |
+------------------+-------------------+------------------+-----------------------+
```

Even uints are always globally interpreted regardless of any declared
namespace — this ensures standard record type mechanisms (compression,
encryption, splitting, §4) work unconditionally inside any namespaced
container, matching the universal pattern across CBOR, XML, NDEF,
Protocol Buffers, and HTTP where infrastructure mechanisms stay globally
interpretable. Odd uints require a declared namespace; without one, the
Record MUST be treated as an abort. Byte string IDs are always global —
collision safety comes from the byte length the developer chose, not from
a namespace. Text string IDs are reserved for future use as
human-readable, self-describing typeIDs — a parser MUST treat them as
valid prefix items (same as uints and byte strings) but no registration
scheme for them is defined yet. Unlike a reserved *numeric* range, which
carries no meaning until one is assigned, a text string already looks
usable the moment it exists — see the caution below for why that
specifically calls for pinning a few rules now, ahead of the full
registration scheme.

**Byte string Type IDs are not the recommended default for "I want a
cheap ID with no registry" — most adopters want a declared namespace
plus a small odd uint instead.** A byte string Type ID pays a real,
recurring width cost (4+ bytes, every single Record Type, forever); an
odd uint inside a declared namespace can be as small as a single byte
and stays collision-free by construction, since the namespace (not the
ID's own width) is what protects it — the "cost" is that the namespace
operator is responsible for not colliding with their own already-issued
numbers, which is trivial bookkeeping for whoever controls one
namespace. This holds regardless of whether that namespace itself is
centrally allocated or fully decentralized (a self-chosen byte string,
below) — either way, once a namespace exists, Record Type IDs inside it
should almost always be small sequential odd uints, not byte strings.

A byte string Type ID remains the right choice for one specific,
narrower case a namespace-scoped uint structurally cannot cover: a
single Type ID that needs to be **independently self-certifying** —
verifiable against its own name by anyone, without trusting a registry,
a namespace declaration, or a possibly-unreachable original author (see
"Optional, self-certifying strengthening," below) — or a Record Type
that's provisionally shipping ahead of a common-vocabulary registration
existing yet (§8), with a clean promotion path to a low registered uint
once one does (via the same backup-typeID mechanism used for any other
promotion, above). Reach for a namespace first; reach for a byte string
Type ID only when self-certification or pre-registry provisional
identity is the actual property you need.

**TypeID form boundary.** A bare typeID item is only ever CBOR major
type 0, 2, or 3 — simple, self-delimiting items a parser can skip with
zero recursion. Major types 1 (negative int), 5 (map), 6 (tag), and 7
(simple/float) are never valid at a typeID-accumulation position: they
either lack a clear use case over the existing forms, violate the
skip-safe principle, or don't make sense as identifiers. Major type 4
(array) is valid at a typeID-accumulation position in exactly one
specific, structurally-recognized shape — a definite-length 2-element
namespace-pairing item (below) — never as a general-purpose typeID form;
an array of any other shape at that position is not a typeID and falls
through to Phase 2's forward-compat skip like anything else unrecognized
there. A future revision could only add a new major type, or a new array
shape, if it preserved the same bounded, zero-recursion skip guarantee.

**Note on even/odd vocabulary reuse.** The even/odd convention also
appears in §3.2 for map *keys* (critical vs. optional). The two
conventions apply to different axes — map keys vs. typeID *values* —
and never overlap in practice. A parser checking whether a *key* is
critical never looks at a typeID's *value* parity, and a parser
classifying the Type ID never looks at field keys' parity. Both
follow the same mnemonic (even = safe/default, odd = conditional/special)
applied at different layers.

An earlier draft also wrapped the Record Map in a CBOR semantic Tag
matching the Type ID as a redundant routing path. That mechanism has been
removed; see [DESIGN.md](DESIGN.md#cbor-tag-routing--removed) and
FINDINGS.md #11 for why. The prefix-based typeID mechanism is sufficient on
its own.

**Backup Type IDs for transitional routing.** When a Record Type's
primary typeID is promoted from a byte string to a registered uint, older
decoders that only recognize the byte string ID can still find it: the
encoder carries the old byte string as a second (or subsequent) prefix
item alongside the new uint primary. The parser accumulates all prefix
typeIDs into a contiguous run; a decoder that recognizes any one of them
can route the Record. Once the transitional window passes, the backup
items can be dropped — they are never required, just a bridge.

```
Prefix: 100, h'A7F90B3C'    // primary uint 100 + backup byte string
```

A Record never needs more than a handful of prefix typeIDs; the parser
silently drops any beyond `MAX_TYPE_IDS` (recommended: 4).

**Namespace-pairing prefix item: a Record MAY declare or override its
own namespace inline, independent of the container discriminator's
ambient one (§3.5).** Any position in a Record's contiguous prefix run
that would otherwise hold a bare typeID item MAY instead hold a
**namespace-pairing item**: a definite-length CBOR array of exactly 2
elements, `[namespace, typeId]`, where `namespace` is a valid Namespace
ID (a uint greater than 0, or a byte string — the same convention as
the container discriminator's own namespace value, §3.5) and `typeId` is
a uint (never a byte string — decentralized Record IDs stay a separate,
unpaired, always-global mechanism; see below for why pairing one would
not actually help). When present, the array's second element becomes
the ordinary routing typeID at that prefix position (primary if first,
backup if not); the array's first element declares the namespace that
specific typeID is scoped against, taking priority over the container's
ambient namespace for this one Record. Every other Record in the same
container is unaffected — this is a purely local override.

```
Prefix: [h'a9d6e1f30b7c4482', 1]    // this Record's own namespace,
                                     //   paired with a scoped typeID
```

An even (Allocated/global) `typeId` inside a pairing is vacuous: §3.5's
invariant that even uints are always globally interpreted, regardless of
any declared namespace, is unconditional and unaffected by pairing — a
paired namespace only has an effect on an odd (Scoped) `typeId`. Pairing
is not a way to give an even typeID a namespace-flavored meaning; it
exists solely so an odd typeID can be scoped to something other than
whatever the container's discriminator ambiently declares.

**This is not a cheaper way to obtain a decentralized ID — it is a
narrow, opt-in override, and is more expensive per use than either
alternative it might be confused with.** Unlike the container
discriminator (paid once, amortized across every Record in the
container), a namespace-pairing item is paid fresh on every Record that
carries one — there is no amortization. A Record that wants a
collision-safe global ID with no namespace involved at all should still
use a plain, unpaired byte string Type ID (above); a Record that's happy
with the container's ambient namespace should still use a bare typeID.
Namespace-pairing exists to answer one specific question — "can this one
Record use a namespace other than the container's ambient one" — enabling
more than one namespace to coexist within a single container without
taxing the common single-namespace case: every Record that doesn't need
an override still costs exactly what it always did. See DESIGN.md's
"Multiple namespaces per container" for the verified byte-cost
comparison and the two previously-considered mechanisms this one
replaces.

**Purely structural for the mandatory core (§3.3): recognizing the
2-element-array shape and extracting its nested typeId is all the core
does — it never learns what a namespace is, never compares it against
anything, never applies even/odd scoping logic.** That interpretation
(preferring a Record's own paired namespace over the container's
ambient one when resolving an odd typeID's scope) is
Record-Type-interpretation-specific handling, the same optional tier
§3.5's namespace semantics already live in.

**Implementer caution for byte string Type IDs:** a byte string Type ID
MUST be a definite-length CBOR byte string (major type 2), never
indefinite-length. The minimum byte length is 2 bytes — shorter IDs
have unacceptable collision probability. A byte length of 4 or more bytes
is recommended for global (unnamespaced) use; 2 bytes is acceptable within
a declared namespace where the namespace itself provides collision safety.
SHA-256 over the name's raw UTF-8 bytes (not any CBOR encoding of the
string) was chosen as the hash algorithm for derivation for the same
reason `group_id` and CoAP/COSE registry reuse elsewhere in this spec
favor already-ubiquitous, already-implemented primitives over inventing
new ones.

**Implementer caution for text string Type IDs:** a text string Type ID
MUST be a definite-length CBOR text string (major type 3), never
indefinite-length — the identical skip-safety requirement byte string
Type IDs already have, above, for the identical reason: an
indefinite-length string can only be measured by walking its chunks,
the unbounded-recursion-adjacent hazard §3.2's field-value-shape rule
already exists to keep out of this format entirely.

**Comparison MUST be exact, byte-for-byte over the raw UTF-8 encoding —
no Unicode normalization, case-folding, or whitespace trimming.**
Leaving this unstated would repeat a mistake this project has already
made once and paid for: §3.1's own hash-derivation algorithm shipped
without a pinned comparison rule and produced a real, silently-wrong
verification bug in the prototype before two independent
implementations were actually checked against each other (FINDINGS.md
#21). Pinning the rule here, before any text string Type ID has
shipped in real content, costs nothing and heads off finding the same
class of bug a second time.

A bare, unqualified text string Type ID (`"wifi"`, `"config"`) carries
exactly the same collision hazard as an unqualified hash-derivation
name, below — being human-readable doesn't make a word collision-safe,
and text string Type IDs are always global, so nothing but the string's
own distinctiveness protects it. The same reverse-domain qualification
guidance below applies here.

**Text string Type IDs are not yet safe to rely on for guaranteed
cross-implementer uniqueness.** "Reserved for future use" means exactly
that: no registration scheme exists, no authority is checking for
collisions, and nothing guarantees an unrelated implementer hasn't
already picked the identical string for something else. Treat any
current use as experimental/private-use, not interoperable, until a
real registration scheme is defined (§8).

**Implementer caution for uint Type IDs:** a uint Type ID MUST be encoded
as a native CBOR uint (major type 0), never wrapped in a bignum tag
(CBOR tag `2`/`3`) — that would violate this section's own rule and
§3.2's field-value-shape rule identically. Verify your specific encoder
does this, not just that some CBOR library is present: this repo's own
Node prototype had exactly this bug for its entire history, undetected
because none of its own worked examples ever used a Type ID large enough
to trigger it. See FINDINGS.md #14.

**Optional, self-certifying strengthening (not required):** a
decentralized Type ID MAY be derived as a truncated hash of its own
Hint name string rather than pure randomness. This upgrades the name
from an unverifiable claim into something anyone can independently check —
recompute the hash, compare to the typeID — without trusting a registry or a
possibly-unreachable original author, the same "hash as proof" instinct
already behind `group_id` (§4.1) and the Sign coverage scheme (§8).
The Hint name is carried as a subsequent prefix item (backup typeID) or
inside the field map at an odd/optional key, depending on context.

**The derivation algorithm is pinned, not left as "hash(name)" with
implementation-defined details** — "anyone can independently check" is
only true if independent implementations actually agree on what they're
computing:

```
digest = SHA-256(UTF-8(name))
N      = developer-chosen byte length (minimum 2, recommended 4+)
TypeID = digest[0..N] as a definite-length CBOR byte string (major type 2)
```

The developer chooses `N` directly — wider means more collision-safe. A
namespace-scoped ID can safely use a shorter `N` (e.g. 2 bytes) because
the namespace itself provides collision safety; a global ID without a
namespace should use 4 or more bytes for adequate collision resistance.
The full 32-byte SHA-256 digest is expected to live in documentation for
verification purposes; only the truncated form appears on the wire.
SHA-256 over the name's raw UTF-8 bytes (not any CBOR encoding of the
string) was chosen for the same reason `group_id` and CoAP/COSE
registry reuse elsewhere in this spec favor already-ubiquitous,
already-implemented primitives over inventing new ones.

Recommended truncation lengths:

```
+-------------+------------------+---------------------------------------+
| Byte length | Collision space  | Recommended context                  |
+-------------+------------------+---------------------------------------+
| 2           | ~65K             | Record Type ID within a declared      |
|             |                  | namespace only (§3.5)                 |
| 4           | ~4 billion       | Any Record Type ID (minimum for       |
|             |                  | global use); minimum for namespace IDs|
| 8           | ~1.8×10¹⁹       | Record Type ID (no namespace),        |
|             |                  | maximum safety                        |
+-------------+------------------+---------------------------------------+
```

**Note:** These recommendations apply to Record Type IDs (prefix items).
Namespace IDs (the container discriminator, §3.5) are the global root of trust for all
scoped IDs within a container — two unrelated namespaces with the same
ID would cause all their scoped Type IDs to collide. Namespace IDs MUST
therefore use at least 4 bytes; 8 bytes is recommended for maximum safety.

**Pinning the algorithm only solves half the problem — the input `name`
still has to be collision-resistant itself, or the derived ID inherits
whatever collision risk the name has.** SHA-256 is a good hash, but a
good hash of a bad input is still a bad input: two unrelated
implementers who each pick a short, generic word for a similar concept
("config", "settings") derive the *exact same* ID — a certain collision,
not a probabilistic one, since the derivation is deterministic. This is
worse than skipping hash-derivation and drawing a Type ID purely at
random, which at least gets real collision-safety from the size of the
draw space.

**A name feeding hash-derivation SHOULD be qualified by something the
namer actually, verifiably controls** — a reverse-domain string
(`"com.example.tagdrop"`) is the recommended convention, the same one
Java packages, XML namespaces, and MIME subtypes already use for
exactly this reason. It's not a style preference: a domain two
unrelated parties could plausibly both register is already vanishingly
unlikely by construction (DNS is itself a collision-free allocation
system), which is what actually restores the "behaves like a random
draw" property the whole mechanism depends on — an unqualified word
does not have that property no matter how good the hash function is.

This matters most exactly where nothing else already protects the
value: a *namespace's* own Hint name (§3.5's key `3`), a *standalone*
decentralized Type ID's Hint name (no namespace declared at all), and a
text string Type ID used as a primary or backup typeID (see the caution
above) — all three are always-global values with nothing but the
string's own distinctiveness standing between them and collision.
A Record-Type-local Hint name used *within* an already-declared
namespace doesn't need this — collision-safety there already comes from
the namespace itself (§3.5), so a bare, unqualified local name is fine.

No version marker is needed to record whether a given ID used this
convention: verification is opportunistic — if the hash matches, the
binding is confirmed; if it doesn't, the Hint name simply degrades to a
plain, unverified label, exactly as if this convention weren't in use at
all.

Prototyped in `prototype/src/typeHint.js` (round-trip, opportunistic
verify, and graceful degradation on both a non-hash-derived ID and a
non-string hint all pass — see `prototype/test/type-hint.test.js`). That
same test file locks in a real bug this exact underspecification caused:
an earlier version of this prototype always truncated to 4 bytes
regardless of the candidate ID's actual width, silently unable to verify
any 64-bit-class ID — exactly the width §8 itself recommends and a real
adopter, TagDrop, actually uses. See FINDINGS.md #21.

**Encoder etiquette (SHOULD, not required):** many optical codes are
quantized into fixed-capacity classes (a QR Version's byte budget at a
given error-correction level); when the payload doesn't fill that budget
anyway, encoders SHOULD spend the otherwise-wasted bytes on Hint names
rather than leave them as padding — the marginal cost is zero, and it's
what makes decentralized Type IDs inferable at scale over time (via field
telemetry correlating observed IDs to observed Hints) even with no
registry coordinating any of it.

### 3.2 The Extensibility Rule (Even/Odd Keys)

Borrowed from PNG's critical/ancillary chunk convention. Note: this even/odd
rule applies to *map keys* only, not to a typeID prefix item's *value* —
see §3.1 for the even/odd classification of Type ID values, which is a
separate convention on a separate axis.

- **Even keys are CRITICAL.** An unrecognized even-numbered key MUST cause
  the parser to abort processing *that record* (not the whole stream —
  other records in the same Sequence are unaffected).
- **Odd keys are OPTIONAL.** An unrecognized odd-numbered key MUST be
  silently ignored; the rest of the record still processes normally.

This gives per-field forward compatibility: a future critical field doesn't
require any version-bump mechanism, only choosing an even key
number the current Record Type doesn't yet define.

**Field values MUST be skip-safe.** A Record field's value — for *any* key,
recognized or not — MUST be one of: an unsigned or negative integer, a
simple value or float, a definite-length byte or text string, or a CBOR
tag (any tag number) wrapping exactly one definite-length byte or text
string directly. A value MUST NOT be a bare array, a nested map, or a tag
wrapping anything other than a definite-length string directly — nesting
a tag inside a tag is exactly as disallowed as a bare array, regardless of
which specific tag numbers are involved (tag `24` wrapping tag `0`, or
tag `24` wrapping itself, are equally out of bounds). Structured content
(a list, a sub-record, anything shaped like an array or map) MUST instead
be CBOR-encoded separately and carried as the payload of a definite-length
byte string, optionally marked with a tag — the same "opaque bytes,
re-parsed only by something that opts in" pattern §4.1's Wrapper Records
already use, just applied at the field level instead of only at the
whole-Record level.

For example, a field carrying a list of supported Wi-Fi channel numbers
(`[1, 6, 11]`) MUST NOT appear as a bare array:

```
7: [1, 6, 11]                     // INVALID — bare array (major type 4)
```

It MUST instead be pre-encoded as CBOR and carried as an opaque byte
string — the outer decoder skips it as 4 bytes at a known length, never
looking inside:

```
7: h'8301060b'                    // VALID — pre-encoded [1, 6, 11],
                                   //   opaque to the outer decoder
```

Or, marked with tag `24` so generic CBOR tooling can also tell it's
re-parseable, not just an application that already knows this key's
schema (both encode the identical 4 payload bytes; the tag only adds a
2-byte marker in front):

```
7: 24(h'8301060b')                // VALID and self-describing — tag 24
                                   //   (0xd818) + a 4-byte string
                                   //   (0x8301060b), 7 bytes total
```

This restriction exists because determining a field's length ordinarily
requires walking into its structure — an unbounded-recursion hazard on
constrained targets. A byte or text string's length is always stated
directly in its own head, so skipping one is pure cursor arithmetic. A tag
doesn't cost that guarantee, *provided* its content is checked to be a
definite-length string directly: skipping one is exactly two fixed header
reads in sequence — never a third, since nesting is rejected outright. See
[DESIGN.md](DESIGN.md#field-value-shape-rule--rationale) for the full
rationale.

**Any tag number is allowed here, not just one** — a deliberate widening
from an earlier draft that permitted only tag `24` (see FINDINGS.md #15
for that history). The content-shape check (definite-length string,
directly, no nesting) is what makes a tag skip-safe; that property holds
regardless of *which* tag number is on the wire, so restricting to a
single number never bought any additional safety. It does, usefully,
still exclude most of the IANA CBOR tag registry on its own: tags whose
own standardized meaning requires array or map content — decimal
fractions and bigfloats (tag `4`/`5`, a 2-element array), rational
numbers (`30`), language-tagged strings (`38`, `[language, text]`, easy
to assume is a bare string and isn't), COSE structures (`96`–`98`, `61`)
— stay excluded not by an arbitrary QDEF restriction but because their
own RFC 8949 definition genuinely requires structure no amount of "it's
a real tag" changes. Tags that are already scalar- or string-shaped by
their own definition (dates, URIs, UUIDs, regex, bignums, base64/base16
conversion hints, typed numeric arrays wire-encoded as byte strings) are
usable directly. This also means QDEF isn't repurposing tag numbers as a
private enumeration space the way the old CBOR-tag routing mechanism did
(§8's "CBOR tag-number collision," now DESIGN.md) — it's letting Record
authors use real, IANA-standardized tags for their intended purpose
(annotating a field's actual semantic meaning), not inventing a QDEF-
specific interpretation of any number. It's also genuinely useful beyond
skip-safety: it lets generic CBOR tooling discover a field's bytes carry
a specific, recognized meaning without needing QDEF-specific schema
knowledge, something a bare, unmarked value can never signal. (Validated
in [`rust/qdef-core`](../rust/qdef-core); see FINDINGS.md.)

**Precondition on "the whole stream is unaffected":** this isolation
guarantee assumes the Record is at least well-formed CBOR *and* obeys the
field-value-shape rule above — a parser needs to determine the Record's
byte length to find where the next Record starts. A Record that fails to
route (no typeIDs in prefix, §3.1) is still well-formed and isolable this way. A Record that is malformed CBOR, or
whose bytes violate the field-value-shape rule (a bare array/map/tag as a
field value), is a stronger failure in both cases: the parser can no longer
determine that boundary and cannot safely resume the Sequence at all.
Implementers should not conflate the two failure classes — only the former
is isolated to one Record.

### 3.3 Conformance Levels

QDEF is designed so a minimal, generic parser is genuinely minimal — no
implementer has to bring a compression library or sector-reassembly logic
just to support the *container*:

- **Core QDEF parser (mandatory, all implementers):** verify magic, skip
  the discriminator as one opaque CBOR item (§3.5 — never interpreting
  its shape), walk the CBOR Sequence, read each Record's prefix typeIDs
  to route or skip it, apply the even/odd rule (§3.2) to unrecognized
  keys. That's the entire surface area — no compression, no multi-code
  state, no knowledge of any specific Record Type's fields.
- **Record-Type-specific handling (optional, per Record Type an implementer
  chooses to support):** everything else — including whether a given
  Record Type's payload happens to be compressed, or happens to require
  reassembling several codes — is defined *by that Record Type*, not by
  QDEF. An implementer who only cares about Wi-Fi provisioning (Type 100)
  never has to read, understand, or link against whatever some other
  registered Record Type does internally.

Because of §3.2's field-value-shape rule, a conformant core parser never
needs recursion at all to do its job — not bounded recursion, none. A
Record is always exactly `(typeIDs)* → Map → (scalar | definite-length string)*`:
prefix items followed by one flat map level, walked once. Skipping a field
whose key isn't recognized, or an entire Record whose Type ID isn't
recognized, is always a direct read or a cursor-arithmetic jump, never a
walk into unbounded structure. A conformant core parser SHOULD still reject a Record outright
(rather than attempt to interpret it) the instant it encounters a field
value that violates the shape rule, since by definition that value's true
length can't be determined without doing the recursive walk the rule exists
to avoid. Validated in [`rust/qdef-core`](../rust/qdef-core) — see
FINDINGS.md for the size and code-shape difference this made in practice.

### 3.4 Canonical Encoding

**Encoders MUST produce CBOR meeting RFC 8949 §4.2.1's core deterministic
encoding requirements** for every Record: the shortest-form argument for
every integer, length, and tag; no indefinite-length items; and every
Record Map's keys sorted in bytewise lexicographic order of their own
encoded bytes. QDEF doesn't define a new canonical-encoding rule — it
adopts CBOR's own, unchanged.

This is a requirement on *encoders*, not decoders: a decoder reading field
values back out of a Record MUST NOT reject an otherwise well-formed
Record merely for being non-canonically encoded (key order on the wire
never affects whether `map[N]` is findable — §3's Record Map is a
CBOR map, not something position-dependent). The rule exists for a
narrower, specific reason: anywhere QDEF hashes a Record's bytes for
content-addressing (§4.1's `group_id`, and any future Sign mechanism,
§8), that hash is only meaningful as "same logical content" across
independent tools if those tools agree on what bytes "the same logical
content" produces in the first place. Two conformant encoders handed
identical field values but disagreeing on integer width or map key order
would otherwise compute different hashes for content that's semantically
identical — silently defeating `group_id`'s own stated purpose ("no
coordination is needed between independent encoders," §4.1) the moment
more than one encoder is ever involved, even though the narrower
single-encoder reassembly-integrity check `group_id` performs today
already works regardless of canonicalization.

Not a new implementation burden in practice: most CBOR encoders already
default to shortest-form arguments and definite-length items, since
that's the common case for hand-written or generated values. The one
requirement that needs explicit encoder discipline is map key
ordering — sorting a Record's handful of keys before serializing is
cheap, including on constrained hardware, and §3's Record Maps are small
by construction (a flat set of fields, never nested).

### 3.5 The Container Discriminator

Immediately after the magic (§2), every QDEF container carries exactly
one mandatory CBOR item — the **discriminator** — before the CBOR
Sequence of Records begins. Its job is the same one RIFF's form-type
(`WAVE`/`AVI `) does right after RIFF's own magic: a fast, early "what
kind of file is this" identifier, specifically a format namespace for a
QDEF-based file format that wants one. Unlike a Record, the
discriminator is not itself typeID-prefixed or Map-shaped — it is
whatever single well-formed CBOR item comes next, and its own CBOR major
type is what tells a decoder which of the shapes below it is. The
mandatory core (§3.3) only needs to know how to skip exactly one
well-formed CBOR item to find where the Record Sequence starts — it
never needs to interpret what the item means. That interpretation is
Record-Type-interpretation-specific handling (§3.3's optional tier),
prototyped in `prototype/src/header.js` and never added to the minimal
Rust core (`rust/qdef-core`), which stays exactly as small as before.

**Why mandatory, and not an optional leading Record the way an earlier
draft of this section had it.** An optional item is structurally
ambiguous the instant it's a bare uint or byte string: a decoder
scanning for a discriminator has no way to distinguish "this is the
container's own discriminator" from "this is the first typeID (or a
backup typeID) belonging to the container's first real Record" — both
are the identical CBOR shape at the identical position. A CBOR tag
number could mark the difference, but tag-number collision risk with
other CBOR-based ecosystems already ruled that mechanism out once
(FINDINGS.md #11, [DESIGN.md](DESIGN.md#cbor-tag-routing--removed)).
The only way left to resolve the ambiguity structurally, rather than by
convention a careless encoder could violate, is to make the
discriminator unconditionally present — always exactly one item, always
first, no exceptions — so a decoder never has to guess which case it's
looking at.

**Eight recognized shapes**, dispatched purely by the discriminator
item's own CBOR major type and, for arrays, its element count:

```
+-----------------------------------+------------------------------------------------------------+
| Discriminator shape                | Meaning                                                     |
+-----------------------------------+------------------------------------------------------------+
| uint 0                             | No namespace declared (cheapest legal container: 1 byte)   |
| uint N > 0                         | Allocated Namespace ID = N (registered/common-vocabulary)  |
| byte string                        | Decentralized Namespace ID (self-certifying, no registry)  |
| array [uint, byte string]          | [Allocated Namespace ID, Decentralized backup] — promotion/|
|                                     | transition pair, mirrors §3.1's backup-typeID convention   |
| array [id, text string]            | [Namespace ID (Allocated or Decentralized), Namespace Name |
|                                     | hint] — one shape covering both, disambiguated purely by   |
|                                     | id's own major type                                        |
| array [uint, byte string, text]    | [Allocated Namespace ID, Decentralized backup, Namespace   |
|                                     | Name hint] — all three together                            |
| map                                | Full extensible form: {1: namespace, 3: hint, 5: backup,   |
|                                     | ...}                                                        |
| anything else (unrecognized)       | Degrades to "no namespace" — same graceful degrade as uint 0|
+-----------------------------------+------------------------------------------------------------+
```

```
0                                      // cheapest legal container: no namespace declared

h'a9d6e1f30b7c4482'                    // bare decentralized namespace, no hint

[100, h'a7f90b3c']                     // allocated ID 100, with a decentralized
                                        //   backup ID for older decoders

[h'a9d6e1f30b7c4482', "com.example/tagdrop-paper"]
                                        // decentralized namespace with a
                                        //   recoverable Hint name

[100, "com.example/tagdrop-paper"]     // allocated ID 100, with a plain
                                        //   recoverable Hint name (not
                                        //   self-certifying — a uint can't
                                        //   be hash-derived from a name —
                                        //   just recoverable)

[100, h'a7f90b3c', "com.example/tagdrop-paper"]
                                        // allocated ID 100, decentralized
                                        //   backup, AND a hint, all together

{                                       // full extensible form
  1: h'a9d6e1f30b7c4482',              // namespace: uint or byte string,
                                        //   same convention as §3.1's Type IDs
  3: "com.example/tagdrop-paper",      // OPTIONAL: recoverable Hint name,
                                        //   same pattern as §3.1's hash-
                                        //   derivation hint
  5: h'a7f90b3c'                       // OPTIONAL: decentralized backup ID
                                        //   for older decoders (same role as
                                        //   the array forms' backup slot)
}
```

The array forms exist purely for compactness in the common non-trivial
cases (a promoted allocated ID that still wants a backup, a namespace ID
of either kind that wants a hint, or a promotion in progress that wants
both); the map form is the fully extensible fallback for anything future
revisions need beyond keys `1`, `3`, and `5`, using the identical
even/odd key convention (§3.2) as every other Record's field Map. Array
length disambiguates the 2-element and 3-element forms from each other
before any element is even inspected — a decoder never has to guess
which one it's looking at. An encoder picks whichever of the eight
shapes is cheapest for what it actually needs to say; a decoder MUST
recognize all eight.

**A hint on an Allocated (uint) namespace ID is a plain recovery name,
not a self-certifying one — worth being precise about the difference.**
§3.1's hash-derivation strengthening only applies to byte string values,
since a small uint can't be reconstructed from hashing a name the way a
truncated digest can. What it buys instead is concrete and specific:
**reverse-engineering.** Anyone examining a QDEF container found in the
wild — without access to whatever registry eventually governs the
Allocated tier, or looking at content from before one existed — can read
the namespace's own name straight off the wire instead of having to
guess or look one up externally. The same job Type Hint (§3.1) already
does for Record Type IDs, just one level up; it can't be independently
verified against the ID the way a Decentralized namespace's hint can,
but "recoverable without a registry" was already the actual goal.

**Unrecognized shape degrades gracefully, exactly like `uint 0`.** A
discriminator item that is well-formed CBOR but doesn't match any of the
five namespace-bearing shapes above (for instance, a future revision's
shape an old decoder doesn't yet understand) is treated identically to
"no namespace declared" — never a hard failure. The mandatory core
still only has to skip it as one CBOR item; it never needs to recognize
its shape to do that.

**Not "zero cost when unused" — deliberately, and by design.** Because
the discriminator is unconditionally present, every container pays for
it, including one that wants no namespace at all: `uint 0` still costs
1 byte. This is a considered trade-off, not an oversight — see
[DESIGN.md](DESIGN.md#container-discriminator-redesign) for the full
byte-cost accounting and the reasoning that led here. In short: a
single byte answering "is this a generic QDEF record, or a specific
application's own file format" is proportionally negligible next to any
realistic payload, and it buys back real savings (§3.1's own typeID
prefix items no longer have to do double duty as an ambiguous
leading-Record-or-header guess) the instant a namespace actually is
wanted.

**An application whose carrier already isolates its content from every
other QDEF-aware decoder generally has no need for this mechanism at
all, for the same reason it has no need for §2's magic bytes.** Its own
URI scheme, or an app-specific NDEF MIME type, already guarantees
nothing but that application's own decoder will ever interpret its Type
IDs — the cross-app collision-safety a declared namespace exists to buy
isn't needed when there is no shared, generic dispatch context for other
apps' Type IDs to collide within in the first place. Such an application
can use a small, self-allocated even Type ID (the `32768`+ tier, §4) with
no namespace, no discriminator item at all (§2's own-URI-scheme carrier
path), and no per-code repetition cost — cheaper than namespace-scoping
and just as collision-safe *in that application's own actual
deployment*, even though the same ID would not be safe to assume
collision-free in a shared, generic QDEF container. Namespace-scoping
earns its cost specifically where that isolation doesn't already
exist — a byte-mode QR or an NDEF payload with no app-specific MIME
type, where genuinely unrelated apps' content might share one container.
See DESIGN.md for the real, verified byte-cost comparison this
recommendation is based on.

**Caution: this safety is a property of the carrier at the point of
consumption, not of the bytes themselves — it does not survive reuse
across carriers that don't all provide equivalent isolation.** Even
Type IDs carry zero self-protection of their own (§3.1); "isolated" and
"unisolated" byte sequences are bit-for-bit identical, and nothing in
the wire format marks which one a given blob is. An implementer who
reuses the identical CBOR-sequence bytes across multiple carriers for
implementation simplicity — e.g. the same bytes underlying both an own
URI scheme and a raw NDEF record — MUST verify *every* carrier those
bytes can reach provides isolation, not just the primary one; a single
future carrier added without an equivalently exclusive dispatch
mechanism (a shared/generic MIME type, a bare byte-mode QR with no
distinguishing wrapper) silently reintroduces full collision exposure
for every even Type ID already in use, with no wire-level signal that
anything changed. More fundamentally, this mechanism is in direct
tension with wanting broader interoperability: an application that
wants its content recognizable by tools other than its own decoder is,
by definition, choosing not to stay isolated — for that application,
namespace-scoping or an eventual First Come First Served registry entry
(§4) is the more robust choice, since either stays collision-safe
regardless of which carrier the bytes travel through.

**Recommended pattern for an isolated-carrier application: namespace-
scoped odd Type IDs with the namespace *implied* by the carrier, never
transmitted — not self-allocated even IDs.** An application whose
carrier already isolates it (above) doesn't have to choose between
"cheap but carrier-dependent" (a self-allocated even ID) and "safe but
costs a transmitted discriminator" (an ordinary namespace declaration).
It can have both: decide on a real namespace value once, and have its
own decoder assume that fixed value applies to *any* content reaching it
through *any* of its own carriers — the wire bytes never carry a
discriminator at all (exactly as today, §2), but the decoder's own
Record-Type-interpretation layer resolves odd Type IDs against that
implied namespace instead of treating them as global. This costs nothing
more than the even-ID pattern (odd uints as small as `1` byte, no
discriminator transmitted) but gains real safety: an odd Type ID with no
namespace present is a spec-mandated abort (above), so if the exact same
bytes ever do reach an unisolated carrier, a reader fails *closed*
instead of silently, successfully misinterpreting the ID the way an
unprotected even ID would. It also leaves a clean, zero-renumbering path
to genuine interoperability later — start transmitting that same
namespace value explicitly, via an ordinary discriminator, on whichever
carrier doesn't imply it; the Type IDs themselves never have to change.

The one requirement this depends on: the implied namespace value MUST be
identical across every one of the application's own carriers. Using
different implied values for, say, a URI-scheme path and an NDEF path
reintroduces exactly the cross-carrier inconsistency this pattern exists
to avoid.

**Format namespace values follow the same convention as Record Type IDs
(§3.1): a uint or a byte string.** A uint namespace follows the exact
same tiering as §3.1's uint Type IDs, including the same governed/
ungoverned line — a small span for reviewed/common formats
(Specification Required), an open First Come First Served span above
it (self-allocate freely, recorded but not reviewed once a registry
authority exists), and no allocation authority needed at all for a byte
string namespace, which follows §3.1's decentralized convention —
collision safety from the byte length the developer chose, never
registry-tracked, by design. However, namespace IDs are the global root
of trust:
two unrelated namespaces with the same byte string ID would cause all
their scoped Type IDs to collide. Byte string namespace IDs MUST
therefore be at least 4 bytes; 8 bytes is recommended for maximum
safety. Key `3`'s Hint name plays the same self-certifying strengthening
role as §3.1's hash-derivation hint (pinned algorithm, opportunistic
verify). Prototyped in `prototype/src/header.js`'s
`verifyNamespaceHint`, which calls the same `typeHint.js` derivation
rather than reimplementing it.

**The namespace's Hint name is exactly the case §3.1's naming guidance
calls out as needing qualification, not the case that's exempt from
it.** Nothing outside the namespace itself protects a hash-derived
namespace value from collision — unlike a Record-Type-local Hint name
used *inside* an already-declared namespace, which doesn't need
qualifying. A reverse-domain string (`"com.example.tagdrop"`, not bare
`"tagdrop"`) is the recommended form here specifically.

**No dedicated "version" field, and the discriminator does not get
"versioned" by minting new shapes for future revisions beyond the six
above.** The map form is already the fully extensible escape hatch: a
genuinely incompatible future addition is just a new even/critical key
in the map form, whenever it's actually needed, using the same even/odd
extensibility (§3.2) every Record's own field Map already relies on. A
decoder that doesn't recognize a future key inside the map form aborts
only that key's effect (or the whole map form, if the new key is
even/critical) and falls back to unnamespaced — the same graceful,
already-proven degrade every unrecognized discriminator shape gets.

**What a declared namespace changes, and what it doesn't.** Even uint
Type IDs always stay globally, absolutely interpreted regardless of any
declared namespace — standard record type mechanisms (§4: a generic tool
must still be able to unwrap Split/Compress/Encrypt and recognize App
Route inside a namespaced file) *and* registered content types (§8's
Registry governance). This is deliberate: a generic tool that only
implements the standard record types must keep working unconditionally
inside any namespaced container, without needing to know a namespace
mechanism exists at all.

**Odd uint Type IDs become namespace-scoped once a namespace is declared,
reusing the existing flat numbering space rather than carving out a new
range for it.** When the discriminator declares namespace `N`, a subsequent Record's
odd Type ID `T` is no longer looked up as the bare global identity `T` —
its real identity is the *compound* key `(N, T)`, exactly the way a
Bluetooth short UUID only means anything paired with the Base UUID it's
declared against. This is why no new numeric range is needed for the
scoped tier itself: nothing is reinterpreting what `T` means in isolation,
because `T` in isolation is no longer the lookup key at all once a
namespace is present. An app with its own declared namespace can freely
use small, sequential odd Type IDs (`1`, `3`, `5`...) for as many Record
Types as it needs — genuinely minimal on the wire (CBOR encodes any
value `0`–`23` in a single byte, so odd IDs up to `23` cost nothing more
than the smallest possible typeID) and collision-free by construction,
since collision safety now comes from the namespace, not from the ID's
own width. There is no magnitude floor on a namespace-scoped odd
uint — parity alone determines scoping (§3.1), so there is nothing to
be gained by picking a larger starting value.

`N` here is normally the container discriminator's own ambient
namespace, but a specific Record MAY instead pair its own typeID with a
different namespace inline (§3.1's namespace-pairing prefix item),
overriding `N` for that one Record only — the mechanism that lets more
than one namespace coexist within a single container without taxing the
common single-namespace case.

**Byte string Type IDs are always global regardless of any declared
namespace.** Collision safety for byte string IDs comes from the byte
length the developer chose, not from a namespace. A namespace does not
scope byte string IDs — they are looked up by their bare value, same as
even uints. This keeps the decentralized allocation model independent of
namespace scoping: a developer choosing a byte string ID is choosing
collision safety from width, and that choice is unaffected by whether a
namespace happens to be declared.

**Odd uint without a namespace is an error.** An odd uint Type ID without
a declared namespace has no collision safety source — not registry
curation (it's not registered), not numeric width (odd uints can be
small), and not a namespace (none declared). A Record with an odd uint
Type ID and no discriminator declaring a namespace MUST be treated as
an abort of that Record — this is stricter than the current even-uint
fallback, and deliberately so: a wrong match is worse than a clean miss.

**This is Record-Type-interpretation-specific handling (§3.3's optional
tier), not a mandatory-core requirement.** The mandatory core is
unaffected: it still just skips the discriminator as one opaque CBOR
item and reads prefix typeIDs to route or skip Records, with zero
knowledge of namespaces, exactly as validated today (`rust/qdef-core`
needs no discriminator-shape-specific code at all beyond splitting it
off). The correctness obligation
falls on any decoder that implements specific semantics for *any*
odd uint or namespace-local Type ID: such a decoder MUST check for a
declared namespace before applying its interpretation, and MUST NOT fall
back to a global reading merely because it doesn't recognize the specific
`(namespace, TypeID)` pair — that pair is simply unrecognized, skipped the
same way any other unrecognized Type ID is, never silently reinterpreted
as the global meaning of the same number. Getting this wrong is a real,
worse-than-usual failure mode (a *wrong* match, not a clean miss) — it
is the one sharp edge this mechanism has, and it exists precisely because
odd uints are being asked to serve two different lookup schemes (global
vs. namespace-scoped) depending on context a decoder must actually check,
not assume.

**MUST repeat, identically, on every physical code of a multi-code group
whenever that group carries any namespace-scoped (odd uint) Type ID —
whether the scoped Type ID belongs to a plain sibling Record or is only
reachable after a Wrapper stack (§4.1) fully resolves.** Each physical
code is its own independent container, parsed from a blank slate with no
cross-code state (§8) — a decoder holding only one code out of a group
has no way to learn a namespace declared on some other code. This is the
same reasoning that already requires Fallback Hint's URI and App Route's
decentralized form to repeat per code (§4.2, §4.4): a mechanism meant to
work from any single code, or to survive losing one, cannot rely on a
declaration that exists on only one of them. It applies with equal force
to a Type ID only reachable after Split reassembly: `parity_scheme`
(§4.1) recovers a missing *fragment's bytes*, but the discriminator is a
whole leading item, not fragment data — parity gives it no protection
at all. A namespace declared on a single code is therefore a genuine
single point of failure the Split-protected *content* does not share:
losing that one code loses the namespace even when every other code
needed for full content recovery is intact. Once declared, the same
namespace value applies to every Record in that code's own Sequence *and*
to whatever Record a Wrapper stack (Split/Compress/Encrypt) in that
Sequence ultimately resolves to, once fully unwrapped.

**A Wrapper-wrapped Record's inner Type ID is never bare and never
repeated the way a plain sibling Record's is — worth stating as its own
principle, since it changes the byte-cost math for whether
namespace-scoping a given Type ID actually pays off.** A plain sibling
Record with a namespace-scoped Type ID is typically repeated verbatim
across every code (for the same resilience reasons as the discriminator
itself), so shrinking its Type ID to a namespace-scoped odd uint saves
that shrink *N times* — once per code it's repeated on. A Type ID only
reachable after a Wrapper stack (Split/Compress/Encrypt) fully resolves
is structurally different: it exists exactly once, fragmented or
otherwise encoded across the group, reconstructed once at the end — so
shrinking *that* Type ID saves the shrink exactly *once* for the whole
group, not once per code. When computing whether a given Type ID is
worth namespace-scoping, use the repeated-savings math (below) for a
plain sibling and the one-time saving for a Wrapper-reachable one — they
are not the same calculation, and conflating them overstates a
Wrapper-reachable ID's contribution to clearing the discriminator's
own per-code repetition cost. See DESIGN.md's "Namespace repetition
across a multi-code Split group" for a worked example of exactly this
distinction.

**This has a real wire-code cost, now cheaper than the earlier
optional-Record design — verified against the actual encoder, not
assumed.** Repeating a decentralized-namespace discriminator (a bare
4-byte byte string, no hint) on every code costs 5 bytes *per code*
(down from the earlier optional Type `0` Record header's 8 bytes,
since the discriminator no longer pays for its own typeID prefix and
map-wrapper framing). Shrinking one namespace-scoped Type ID from a
private-use-random byte string to a small odd uint saves at least 8
bytes for a genuinely minimal odd uint. A single namespace-scoped Type
ID repeating alone on each code is therefore already a net **win**
(+3 bytes/code) on its own, not merely a breakeven — an adopter should
still count how many namespace-scoped Type IDs actually co-occur per
physical code before assuming the savings compound, since only the
first shrunk ID needs to clear the discriminator's now-smaller,
per-code repeated cost.

Prototyped in `prototype/src/wrappers.js`'s `resolveStack`: reads each
code's discriminator via `header.parseDiscriminator`, requires every
code that declares one to agree, and applies the agreed namespace to
whatever Record the stack ultimately resolves to.
`prototype/test/multi-code-namespace.test.js` demonstrates the
mechanism end to end — including the single-point-of-failure case
above, reproduced directly: a namespace declared on only one code
resolves correctly while that code survives, and aborts the instant
it's the one dropped, even though XOR parity fully recovers the
Split-protected content regardless.

**Fully additive, no migration forced.** An app with existing even uint
or byte string Type IDs keeps them working forever, namespaced container
or not — nothing about this mechanism invalidates any ID that predates it.
Adopting namespace-scoped odd uint IDs for *new* content is an
independent, opt-in choice; an old ID and a new scoped one for "the same"
logical Record Type never collide, because an even or byte string ID was
never namespace-scoped to begin with.

Prototyped in `prototype/src/header.js` and `prototype/test/header.test.js`:
round-trip coverage for all six discriminator shapes, the
unrecognized-shape graceful degrade, the JS falsy-zero trap guarded
against explicitly, and cross-validated against the Rust core
(`rust/qdef-core`), which needs no discriminator-shape-specific code at
all to split it off and route/walk the Records that follow correctly.

## 4. The QDEF Standard Record Types

QDEF is a *format plus a set of standard record types*, not just the
format — the same relationship C-the-language has with libc. §3 defines
a minimal core any conformant parser must implement, and says nothing
about compression, splitting, encryption, or graceful degradation for
scanners that don't understand a given Record Type. Those live here
instead: a small, curated set of Record Types any application can pull
in — writing no reassembly code, no cipher code, no fallback-routing
code of its own.

**Standard record type IDs:** even numbers `2`–`98` are reserved for
these standard record types, maintained alongside the QDEF spec itself.
Even numbers `100` and above are open for applications to register their
own domain-specific Record Types ([EXAMPLES.md](EXAMPLES.md)) — who governs *that*
allocation is still open (§8), but at least the two registries are
partitioned by construction and can't collide.

**Currently assigned Type IDs — the complete list, gathered in one
place.** Each is defined in full in its own subsection below; this
table exists purely so an implementer can check or cross-reference an
ID at a glance without hunting through prose, since a typo here (using
the wrong number for a standard record type) collides silently with
whatever real ID that number belongs to instead of failing loudly:

```
+------+------------------+---------+---------------------------------+
| ID   | Record Type      | Section | Notes                          |
+------+------------------+---------+---------------------------------+
|  2   | Split            | §4.1    | Fragment reassembly / parity    |
|  4   | Encrypt          | §4.1    | AEAD (e.g. AES-256-GCM)         |
|  6   | Media Payload    | §4.3    | Typed binary content            |
|  8   | Compress         | §4.1    | DEFLATE                         |
| 10   | Fallback Hint    | §4.2    | URI fallback for unaware readers|
| 12   | App Route        | §4.4    | Application dispatch/routing    |
+------+------------------+---------+---------------------------------+
```

All six are placeholders pending a real registry authority (§8), not
protected allocations — see "Registering a real Type ID before
governance exists," below, for what that means for an adopter shipping
against one of these numbers today.

**Type ID allocation ranges** (adapted from CBOR's tag registry pattern,
RFC 8949 §9.2):

```
+----------------+----------+----------------------------------------------+
| Range          | Even/Odd | Purpose & governance                         |
+----------------+----------+----------------------------------------------+
| 0–22           | even     | Standards Action — Wrapper Records and other  |
|                |          | standard record type infrastructure,         |
|                |          | spec-maintained                              |
| 24–98          | even     | Specification Required — standard record     |
|                |          | types reserved for future use                |
| 100–32767      | even     | Specification Required — common vocabulary,  |
|                |          | reviewed application-specific types          |
| 32768+         | even     | First Come First Served — self-allocated     |
| odd uints      | odd      | Namespace-scoped only (§3.5) — requires      |
|                |          | declared namespace, abort otherwise          |
| byte strings   | —        | Decentralized — always global, collision     |
|                |          | safety from byte length (§3.1)               |
| text strings   | —        | Named IDs — reserved for future use as       |
|                |          | human-readable typeIDs (§3.1)                |
+----------------+----------+----------------------------------------------+
```

Byte string IDs are always global regardless of number; they provide
collision safety from byte length, not from registry position. Text
string IDs are recognized as valid prefix items by parsers but have no
registration scheme defined yet.

**"Governed" and "review-gated" are independent properties, not the
same axis — this is the actual line between the tiers above.** Every
tier's collision-safety comes from exactly one of three sources:
curation (a registry that both records *and* reviews an allocation
before granting it), recording (a registry that tracks who claimed
what, first-come, with no review gate), or self-certification (the ID's
own width/derivation, with no registry involved at all, ever). Standards
Action and Specification Required both sit in the first category
(reviewed); First Come First Served sits in the second (recorded, not
reviewed); byte string IDs sit in the third (no registry, by design,
permanently — not merely "not yet registered"). No registry authority
exists today for *any* uint tier (§8) — that's a separate, current-state
fact from which of these three collision-safety models a given tier is
*intended* to use once one does.

**Choosing a Type ID form.** Six mechanisms sit above, each solving
collision-safety a different way — real implementer feedback is that
picking the right one for a given Record Type isn't obvious from the
table alone. Work through these questions in order; stop at the first
`YES`:

```
1. Is this part of QDEF's own standard-record-type infrastructure
   (a Wrapper Record or similar mechanism, not application content)?
     YES -> even uint 0-22 (Standards Action, spec-maintained -- not
            something an application ever picks for itself)

2. Do you want this Type eventually recognized by unrelated
   implementers, even though no registry exists yet (§8)?
     YES -> even uint 100-32767 (Specification Required / common
            vocabulary). Ship now with an illustrative number, or use
            a decentralized byte string as a provisional placeholder
            (step 5) with a clean promotion path later via a backup
            typeID (§3.1).

3. Does your application already have -- or are you willing to
   declare -- a namespace (your own allocated one, or a self-chosen
   decentralized one)?
     YES -> a small sequential odd uint (1, 3, 5...) inside that
            namespace. The cheapest option (as little as 1 byte), and
            if your carrier already isolates you (own URI scheme, own
            NDEF MIME type), the namespace itself can be implied by
            that carrier and never transmitted at all (§3.5) -- so
            this option is usually available "for free" even without
            wanting to pay for an explicit namespace declaration.

4. Do you need this specific ID to be independently self-certifying
   -- verifiable against its own name by anyone, with no namespace or
   registry involved at all?
     YES -> a decentralized byte string, hash-derived from a qualified
            name (§3.1's self-certifying strengthening). This is the
            one job nothing else here can do; it is not a general
            substitute for step 3.

5. Is your carrier already isolated, and you're accepting that its
   safety is carrier-dependent (§3.5's caution) rather than reaching
   for step 3's implied-namespace pattern instead?
     YES -> a self-allocated even uint, 32768+ (First Come First
            Served). Cheapest form available, but re-read step 3 first
            -- the implied-namespace pattern costs the same and is
            strictly safer for an already-isolated carrier.
     NO  -> you need a namespace after all; go back to step 3.
```

Most application Record Types resolve at step 3 — a declared namespace,
implied or explicit, with small sequential odd uints inside it. Steps 2,
4, and 5 are each real, but narrower than they might first appear; see
DESIGN.md's "Registry governance" and FINDINGS.md #29/#30 for the full
reasoning behind why namespace-scoping is the default rather than any
of the alternatives.

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

Reserved Wrapper Type IDs (placeholders, pending a real registry):

```
Type 2: {                    // Split
  // prefix typeID: 2
  // field map:
  0: h'<group_id>',          // CRITICAL: content-addressed (a hash of the
                              //   full reassembled bytes) — never an issued
                              //   serial, so no coordination is needed
                              //   between independent encoders (relies on
                              //   §3.4's canonical-encoding rule to actually
                              //   hold across more than one encoder). A
                              //   decoder MUST recompute this hash after
                              //   reassembly and reject a mismatch — it
                              //   doubles as the group's integrity check.
  2: 1,                      // CRITICAL: this fragment's index
  4: 4,                      // CRITICAL: total fragment count in the group
  6: h'<fragment bytes>',    // CRITICAL: this code's slice
  7: 5821,                   // OPTIONAL as a key (odd), but MUST be present
                              //   whenever key 9 (parity_scheme) is set —
                              //   see chunking rule below. When present:
                              //   total_bytes of the reassembled whole.
  9: 1                       // OPTIONAL: parity_scheme — 0/absent = none,
                              //   nonzero selects a registered forward-
                              //   error-correction scheme so the group
                              //   tolerates a missing/damaged code.
}

Type 8: {                    // Compress (DEFLATE)
  // prefix typeID: 8
  // field map:
  0: h'<deflate bytes>'      // CRITICAL
}

Type 4: {                    // Encrypt (e.g. AES-GCM)
  // prefix typeID: 4
  // field map:
  0: h'<nonce>',             // CRITICAL
  2: h'<ciphertext+tag>',    // CRITICAL
  3: 3,                      // OPTIONAL: Algorithm — 3 = A256GCM
  5: -25                     // OPTIONAL: Key Algorithm — -25 = ECDH-ES+HKDF-256
}
```

**Keys `3` (Algorithm) and `5` (Key Algorithm)** are each a uint or a text
string, an encoder's choice — the same two-form pattern as §4.3's Media
Type, and for the same reason: both name something with a stable identity
independent of QDEF, so there's no opacity for a decentralized-ID-plus-
hint layer to resolve, just a compact number when one's registered and a
plain string otherwise.

- **A uint** is a [COSE Algorithm
  ID](https://www.iana.org/assignments/cose/cose.xhtml) (RFC 9053/9054) —
  an existing, actively maintained IANA registry, tiered by governance
  strictness the same way CoAP's Content-Formats and QDEF's own Type ID
  space are. It already covers both halves of this problem: content
  encryption algorithms (`1`/`2`/`3` = A128GCM/A192GCM/A256GCM) *and*
  key-agreement/wrap/derivation algorithms (`-25` = ECDH-ES+HKDF-256,
  recipient-public-key wrap; `-10` = direct+HKDF-SHA-256, a shared
  secret/passphrase; `-5` = A256KW, key wrap) — including negative
  integers, which §3.2's field-value-shape rule already permits.
- **A text string** names the algorithm directly for anything not
  registered there.

Key `5` resolves this Wrapper's other long-standing gap: which cipher was
actually used was previously only ever an implicit, out-of-band
assumption (the `(e.g. AES-GCM)` comment above was illustrative, not a
field). Key `7` is the fix for the key-provisioning gap specifically: two
independent apps can now interoperate on *how* the symmetric key was
obtained, not just agree that something called "Encrypt" happened.

Both keys are odd/optional, matching `parity_scheme`'s precedent (§4.1's
Split fields) rather than nonce/ciphertext's: absent, everything works
exactly as before (two ends that already agree out of band, as in §7's
worked example, need neither field), and a decoder that doesn't recognize
either key simply falls back to whatever algorithm it already assumed —
which fails safely either way, since AEAD's own authentication tag check
already catches a wrong-algorithm or wrong-key attempt. They exist for
when unrelated apps need self-description, not to tax the case that
already works.

**A decoder that does honor key `3`/`5` MUST NOT let them broaden which
algorithms it's willing to run** — the same "alg" confusion class of
vulnerability JOSE/JWT is well known for (an attacker-controlled
algorithm identifier tricking a verifier into a weaker or inappropriate
algorithm than it intended). Treat the field as a hint to check against
an application-chosen allowlist, never as an instruction to trust
outright.

**Encrypt cannot provide deniability, and that's a scope boundary, not a
gap.** Being wrapped in a Type-`4` Record at all is itself a visible
declaration — "this is encrypted content" — to any QDEF-aware parser
walking the Sequence, whether or not it can decode the payload, because
Type ID routing (§3.1) happens unconditionally before any per-Record-Type
logic runs. An application whose threat model requires ciphertext
indistinguishable from random has a requirement this wrapper structurally
cannot satisfy no matter how its fields are shaped — self-describing
dispatch is the format's entire reason for existing. Such an application
should keep its own encryption entirely inside an opaque registered blob
(§5) rather than use this wrapper, the same way any application with its
own proven mechanism should (§6). See FINDINGS.md #13.

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
zero-padded to `chunkLen` before XOR; a recovered fragment is truncated
using the missing index's known slice boundaries). It is also a real
constraint on encoders: a Split group can't freely give different physical
codes different-sized fragments to match each code's own capacity while
still supporting parity recovery under this rule. That tension is not yet
resolved — see §8.

`parity_scheme` mechanics: a parity fragment (index ≥ `count`, present only
when `parity_scheme` is set) is pure bonus redundancy — plain reassembly
only ever requires fragments `0` through `count − 1`. A decoder that
doesn't understand `parity_scheme` can just ignore any fragment past
`count` and still reassemble correctly in the all-present case — it only
loses resilience, never correctness. `parity_scheme = 1` (prototype-defined
only, not yet a real registry entry): a single XOR parity fragment,
recovering exactly one missing/damaged real fragment.

**Fixed nesting order** when more than one Wrapper is combined: `Split
(outermost, if present) → Encrypt → Compress → plain inner Record`.
Compress-before-encrypt is the only sound order between those two
(ciphertext doesn't meaningfully compress). Split-outermost is the
*recommended* order for efficiency — one encrypt/compress operation covers
the whole payload instead of one per fragment — but **it is not structurally
required and a decoder cannot detect or reject a different order**: the
generic resolver described above has no notion of "correct" order, it just
keeps unwrapping whatever Wrapper Type ID it finds next — confirmed
against a prototype run of both the documented order and a deliberately
reversed one (see FINDINGS.md #7 and
[DESIGN.md's "Nesting order enforcement"](DESIGN.md#nesting-order-enforcement--now-answered-not-open)).

**Why a wrapper, not a reserved key range on the inner record itself:**
wrapping avoids a cross-record correctness hazard. See
[DESIGN.md](DESIGN.md#wrapper-records--why-a-wrapper-not-a-reserved-key-range)
for the full rationale.

**Cost:** wrapper framing (CBOR map + a few keys) is added per code on top
of the inner record, so this stays strictly opt-in — a Record Type with no
need for it stays a plain, unwrapped Record, exactly as cheap as
[EXAMPLES.md](EXAMPLES.md).

### 4.2 Fallback Hint (optional)

Unlike §4.1, this is deliberately **not** a wrapper — a plain standard record type Record
Type meant to sit as a *sibling* alongside real content records in the same
CBOR Sequence, carrying a URI any generic tool can follow if it doesn't
understand anything else in the container:

```
Type 10: {                         // Fallback Hint (standard record type)
  // prefix typeID: 10
  // field map:
  0: "https://example.com/open-this",  // CRITICAL: a URI a generic tool
                                        //   or browser can follow
  1: "Open in MyApp"                    // OPTIONAL: human-readable label
}
```

This is what gives a QDEF container the "something useful happens even
without the specific app" property. It **must** stay a plain sibling
record, never nested inside a Wrapper — its entire value is being visible
to a parser that understands nothing else in the container, which a
Wrapper's opaque payload would defeat.

### 4.3 Media Payload (optional)

A plain standard record type Record Type — not a wrapper — for attaching a standard,
already-widely-recognized media type (a JPEG thumbnail, a vCard, a PDF
snippet) without registering a bespoke Type ID for every possible file
format the way [EXAMPLES.md](EXAMPLES.md) does for application-specific content:

```
Type 6: {                          // Media Payload (standard record type)
  // prefix typeID: 6
  // field map:
  0: 22,                           // CRITICAL: Media Type — uint or text,
                                    //   see below (22 = image/jpeg)
  2: h'<payload bytes>'            // CRITICAL: the content itself
}
```

**Key `0` (Media Type) may be a uint or a text string** — an encoder's
choice, and a decoder MUST accept either shape (both are already
skip-safe under §3.2's field-value-shape rule regardless of which an
encoder picks):

- **A uint in `0`–`65535`** is a [CoAP Content-Format
  ID](https://www.iana.org/assignments/core-parameters/core-parameters.xhtml)
  (RFC 7252 §12.3, as amended by RFC 9876) — an existing, actively
  maintained IANA registry that already assigns compact numeric IDs to
  common media types (`application/cbor` = 60, `image/jpeg` = 22,
  `image/png` = 23, `application/json` = 50, `text/plain;charset=utf-8` =
  0, and hundreds more), tiered by its own governance the same way QDEF
  tiers its own Type ID space. QDEF doesn't invent a numbering scheme
  here; it borrows one that already exists and is already CBOR-friendly
  (a plain small uint).
- **A text string** is the literal MIME type, spelled out directly — used
  whenever the media type isn't in CoAP's registry (e.g. `"text/vcard"`,
  confirmed absent as of this writing). Deliberately *not* a decentralized
  numeric ID paired with a hint field, unlike Type ID (§3.1): a media type
  already has a stable, globally-meaningful name independent of any
  numeric registry (defined by RFC 6838's Media Types registry, which
  predates and doesn't depend on CoAP's numeric shortcut for it) — there's
no opacity problem here for a hint to solve. A private-use Type ID has
*no* other identity besides the number, which is exactly why a hash-
derivation hint has to exist; a media type not in CoAP's table already
has its name, so
falling back to the plain string directly is sufficient, not a
workaround.

**Depending on an external registry is a deliberate, conditional choice,
not a default.** It's only justified here because CoAP's Content-Formats
registry specifically has good prospects of staying maintained — IANA-run,
IETF-governed, updated as recently as 2025 (RFC 9876) — not merely because
*some* external registry existed to point at. QDEF should not casually
crib from a numbering scheme with a shakier maintenance outlook just to
avoid inventing one. Even so, adopters relying on this field should keep a
periodic mirror of CoAP's Content-Formats table (even just checked into a
repo alongside their own code) — cheap insurance so the numbering can be
forked and kept alive independently if that registry ever does go
unmaintained, rather than leaving every uint in this field meaningless.

Prototyped in `prototype/test/media-payload.test.js`: both the
CoAP-numeric and plain-string forms round-trip, and an application with
no interest in Media Payload skips the whole Record cleanly by Type ID
prefix alone — the same "unaware decoder pays nothing" guarantee every other
standard record type gets, not just an aspiration.

### 4.4 App Route (optional)

A plain standard record type Record — not a wrapper — for letting a generic
QDEF-aware scanner offer to launch a specific handling application,
comparable to NFC's Android Application Record (AAR) or platform
Intent-filter dispatch, without the scanner needing any
implementer-specific knowledge baked in ([GitHub issue
#10](https://github.com/mofosyne/qdef/issues/10)):

```
Type 12: {                         // App Route (standard record type) — domain form
  // prefix typeID: 12
  // field map:
  0: "example.com",                // CRITICAL: a domain the routing
                                    //   target has verified control over
  1: "Open in Example App"         // OPTIONAL: human-readable label
}

Type 12: {                         // App Route (standard record type) — decentralized form
  // prefix typeID: 12
  // field map:
  0: h'<truncated SHA-256>',      // CRITICAL: decentralized/random byte
                                    //   string ID (§3.1)
  1: "com.example/tagdrop-paper"   // OPTIONAL: Hint name, same role as
                                    //   §3.1's hash-derivation hint
}
```

**Key `0` may be a domain string or a decentralized byte string — two
genuinely different trust models for two genuinely different purposes,
not two encodings of the same thing.**

*The domain form* is deliberately narrower than a bare package name or
reverse-domain string could be. A plain string claim
(`"com.example.official"`) has no protection against spoofing: anything
can claim to be any string. A domain is verifiable using the mechanism
Android App Links and iOS Universal Links already deploy (a
`.well-known` file — `assetlinks.json` on Android, `apple-app-site-
association` on iOS — hosted on the domain the claimant controls) — QDEF
inherits that existing, proven trust machinery on both platforms instead
of inventing a new one. Use this form for auto-launch dispatch, where
getting it wrong means the wrong application opens.

*The decentralized form* reuses §3.1's hash-derivation pattern: a
decentralized byte string ID, with key `1` playing the Hint name role — a
recoverable name, optionally derived as `ID = truncate(SHA-256(name), N)`
so the binding is checkable rather than an unverifiable claim, exactly as
described there. **This form has no anti-spoofing property, and that is not a
detail to gloss over.** The hash-derivation proves *name-to-ID
consistency* — that this specific ID was reproducibly derived from this
specific name — never *authorization*. Anyone can compute
`SHA-256("Example App")` and truncate to the same bytes; nothing about this form proves
the claimant is entitled to it, unlike the domain form's real ownership
proof. Use this form only where getting it wrong costs *effort*, not
*trust* — the intended case is a fast, per-code pre-filter a scanner uses
to reject obviously-unrelated scans (a misread, an unrelated nearby QR
code) before attempting the real work of reassembly, layered *ahead of*
§4.1's `group_id` integrity check, never as a replacement for it. A false
match here just means a decoder wastes effort before `group_id` catches
the mismatch anyway — not a wrongly-launched application.

Resolving a domain to an actual launch target is intentionally left to
local, OS-level dispatch — no centralized QDEF-level registry or
governance body is needed for it to function at all — but *how* that
resolution is triggered is platform-specific, not a single uniform
mechanism, and a scanner implementer needs to know which path they're
using:

- **Android** exposes an explicit query (`PackageManager` Intent-filter
  resolution) a scanner can call to ask "which installed app claims
  this domain" before deciding what to do — closer to how AAR dispatch
  already works.
- **iOS** exposes no equivalent query. A scanner instead constructs an
  actual `https://` URL from the domain (e.g. `https://example.com/`)
  and opens it (`openURL:`); iOS itself checks the domain's `apple-app-
  site-association` registration as a side effect of opening that URL,
  handing it to the registered app or falling through to Safari. The
  dispatch decision happens *inside* opening the URL, not as a separate
  lookup step.

Both still satisfy "matched only against what's actually installed
on-device, no QDEF-level registry" — the end-user outcome is the same on
either platform — but a scanner implementation needs the platform-
specific mechanism, not a shared cross-platform API, since none exists.

Key `0` carries the bare domain, not a full URL — the iOS path above
constructs `https://<domain>/` (root) from it when actually opening a
URL; an App Route Record isn't the place for path-level routing, which
belongs to the payload the application itself defines once launched.

**Deliberately decoupled from payload-shape Type IDs, not folded into
them.** An open, shared payload shape should be able to stay
interoperable across multiple independent handling applications;
routing identity is a separate concern layered alongside the payload
via a sibling Record, not encoded into the payload's own Type ID. This
also means adopting App Route never requires restructuring an
application's existing Type IDs.

**Not positionally special.** QDEF's dispatch already routes by Type ID
prefix regardless of position (§3.1), so this Record doesn't need a
fixed position in the Sequence — a decoder finds it the same way it
finds any recognized Record Type.

**Encoder etiquette — split by form, because the two forms serve
different moments in a scan.** Both forms should always be small and
plain — never Compress- or Split-wrapped — so a scanner can read one
without reassembling anything else first. Where they diverge is
repetition across a multi-code group:

- *The domain form* (SHOULD, not required): repeat it verbatim on every
  code if the adopter wants auto-launch to work from whichever code
  happens to get scanned first. Putting it on a single designated code
  only — e.g. a "metadata" code that's always scanned first by
  convention — is also a valid choice; the cost is that auto-launch
  dispatch only fires from that code, not a spec violation.
- *The decentralized form* (SHOULD repeat on every code, more strongly
  than the domain form): its entire value is letting a scanner reject an
  obviously-unrelated scan *before* attempting reassembly. A copy on only
  one code can't do that for scans of any other code in the group — the
  pre-filter simply doesn't run for them, silently losing the only thing
  this form is for. An encoder that places it on a single code should
  treat that as accepting no pre-filtering on the rest of the group, not
  as an oversight-free equivalent to repeating it.

**"Cheap" describes the decentralized form's per-code cost, not its
group-wide total — the two are not the same claim.** Mandatory
per-code repetition means the cost multiplies by fragment count: the
Record shown above (byte string ID plus a Hint name) is cheap on any
one code, but a 7-code Split group pays that 7 times over — for App
Route alone, on top of whatever else repeats per code (Split's
own Wrapper framing, etc.). Dropping the Hint name shrinks a
single Record significantly at the cost of losing the hash-derivation
check. Not a flaw in the mechanism — the per-code repetition requirement
is exactly what makes the pre-filter work at all — but an adopter
choosing between the two forms should weigh this against actual group
size, not just the anti-spoofing difference.

**Scope note.** App Route is QDEF's dedicated mechanism for
cross-implementer routing — not a special case carved out of some
narrower scope. The decentralized Type ID space (§8) was never
restricted to closed/internal use in the first place (DESIGN.md's
"Registry governance" corrects an earlier note that implied otherwise);
self-allocation means no registry gatekeeps *minting* an ID, not that
the ID stays unpublished or unrecognized. What App Route adds on top is
a *trust model* for routing specifically — domain verification for the
form that drives auto-launch, §3.1's existing hash-derivation pattern
for the form that doesn't — decoupled entirely from payload Type IDs so
routing identity and payload shape can evolve independently.

## 5. Adopting QDEF for an existing application-specific format

An application with its own existing binary payload format (e.g. a
proprietary CBOR sequence used today for some other transport) can register
one Record Type ID and carry that payload unchanged, byte-for-byte, as an
opaque blob under a single key:

```
// prefix typeID: N
{
  0: h'<existing payload bytes>'  // CRITICAL: raw bytes, unchanged from
                                   //   whatever that application already
                                   //   defines — QDEF never looks inside
}
```

This lets a QDEF-aware scanner dispatch a single byte-mode QR or NFC tag
containing, say, a Wi-Fi Record *and* this application's own content Record
together — without that application's own decoder changing at all: it
still just reads the raw bytes out of key `0`. This is additive and
opt-in — nothing about the application's own format needs to route through
QDEF for it to keep working exactly as it does today.

(The `mofosyne/tagdrop` project uses exactly this pattern to register its
own byte-mode payload, illustrated here as Type `900` — see that repo for
the worked details. It's one adopter among the format's intended audience,
not the reason this format exists; §7 below is an unrelated adopter using
the same mechanism.)

**Registering a real Type ID before governance exists.** `900` here is an
illustrative placeholder, not a protected allocation — §8's registry
governance for the `100`–`32767` "common vocabulary" tier has no authority
yet, so nothing stops an unrelated adopter from also picking `900`. Any
adopter wiring this pattern into real shipping code *before* that
governance exists should use a decentralized byte string ID (§3.1) instead
of a fixed low number: a few more bytes on the wire, but no allocation
authority needed at all, and no shipping code that has to migrate its
Type ID once a real registry does exist.

**On signing and this registration pattern specifically:** an adopter whose
own signature already covers the fully-reassembled plaintext (signed once,
after all splitting/addressing is resolved, with nothing about the
signature depending on how the content happened to be fragmented in
transit) needs no QDEF-level Sign mechanism at all, wrapper or sibling
(§8). §4.1's `group_id` is already a content hash a decoder MUST verify
after Split reassembly — that alone guarantees "the bytes you got back are
the bytes that went in," which is all a whole-payload signature needs from
the container. The signature fields themselves are just ordinary payload
bytes inside the registered blob, orthogonal to whichever Wrapper stack (if
any) did the fragmenting. `mofosyne/tagdrop`'s own wire format anticipates
exactly this: its signed message is specified over the fully reassembled
stream, independent of per-sector addressing (SPEC.md §10) — so a
Type-900-style registration needs nothing further from QDEF's side for
that content, regardless of whether any given adopter's UI/tooling
actually produces signed multi-sector content yet. An adopter whose
signature is instead coupled to its own splitting/addressing scheme
(covers per-sector metadata, not just reassembled bytes) would not get
this for free — see §8's Sign entry. This reasoning generalizes beyond any
one adopter — see §6's note on signing.

## 6. Compression and splitting across multiple tags/codes

**QDEF itself defines neither** — both stay entirely inside each Record
Type's own payload definition. An application that already solved
reassembly/compression for its own format keeps using its own solution,
unchanged, rather than adopting a second, competing one at the QDEF layer.
See [DESIGN.md](DESIGN.md#why-not-build-compression-or-splitting-into-the-container)
for why these were deliberately kept out of the container.

**The same reasoning applies to signing, not just compression and
splitting.** An application with its own proven authentication mechanism
— e.g. a single hash-then-sign step over the fully reassembled payload,
computed independently of however the transport happened to fragment it —
needs no QDEF Sign primitive for that content either, for the identical
reason: it already solved this, adopting a second, QDEF-native mechanism
would just be a second thing that could disagree with the first. §5's
registration pattern already demonstrates this for an adopter whose
signature covers reassembled bytes; §8's Sign entry is for the different
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

Registers one Record Type, say `950`, for the plain secret-key bytes:

```
// prefix typeID: 950
{
  0: h'<raw secret key packet bytes>'  // CRITICAL
}
```

Because the key material is sensitive and may not fit one code, the app
composes it through two Wrapper Records, in the recommended order from
§4.1 — `Split (outermost) → Encrypt → plain Type-950 Record` (no `Compress`
layer here — key material is already high-entropy, DEFLATE wouldn't help):

```
authoring:  Type-950 Record  →  Encrypt Wrapper (Type 4)  →  Split Wrapper (Type 2)
decoding:   Split Wrapper    →  Encrypt Wrapper           →  Type-950 Record
            (per code)          (after reassembly)            (the real key)
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
