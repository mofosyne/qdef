# QDEF — Design Rationale, Rejected Alternatives, and Open Questions

**Non-normative.** [`QDEF-SPEC.md`](QDEF-SPEC.md) defines the wire format;
this document explains why it looks the way it does — mechanisms that were
tried and removed, alternatives weighed and rejected, and questions this
draft hasn't resolved yet. Nothing here is required reading to implement a
conformant parser; it exists for reviewers, future contributors, and
anyone deciding how to resolve what's still open. See
[`FINDINGS.md`](FINDINGS.md) for the empirical, prototype-driven
discoveries that prompted many of these decisions.

## Registry governance — allocation shape proposed, authority still open

Who allocates application-specific Record Type IDs (`100`+) if this is
meant to be shared across unrelated projects is still open — no registry
authority exists yet, and IDs in the spec remain illustrative placeholders.
But the *shape* of the range has an answer: tier it the way CBOR's own tag
registry (RFC 8949 §9.2) tiers tag numbers — a small span requiring
registration/review, then a larger "first-come" span, then an explicit
private-use span for never-shared/internal Type IDs. QDEF doesn't use CBOR
tags itself (see "CBOR tag-number collision" below), but the *governance
pattern* a mature numeric-ID registry uses is worth borrowing on its own
merits, independent of whether QDEF's wire format happens to touch tags at
all. Two options were weighed and this is the one to build the eventual
policy on:

- **Tiered ranges (recommended):** four tiers, not two, each with a
  different reason to exist:
  - `1`–`99`: mechanism/plumbing (already spec'd, §4) — Wrapper Records
    and other stdlib infrastructure, not application content.
  - `100`–`999`: **common vocabulary** — reviewed, widely-recognized
    content types (Wi-Fi, a URL/URI record, the kind of thing NDEF calls
    a "Well Known Type"). This is the tier for a Record Type enough
    unrelated implementers would want to recognize that it's worth a
    shared, reviewed number rather than everyone reinventing their own —
    the spec's §5 examples (`100`, `105`) already sit here informally.
  - `1000`–`0xFFFF`: first-come-first-served — registered, but no review
    gate beyond "not already taken."
  - `0x10000`+: **decentralized — self-allocated via a large random
    value, not a registry.** This tier needs no allocation authority at
    all: because Type IDs are CBOR uints with no fixed width, an
    implementer who picks a sufficiently large (e.g. 32- or 64-bit)
    *random* number gets collision avoidance from the sheer size of the
    number space, the same way a UUID does — not from anyone checking a
    list. Call it "private-use" if the CBOR/IANA-registry parallel this
    name draws on is useful (RFC 8949 §9.2's own private-use ranges), but
    don't read "private" as "closed." Self-allocation is about who has to
    grant permission to mint an ID — nobody — not about whether the ID
    stays undisclosed or single-party: Unicode's Private Use Areas and
    Bluetooth's private/random device addresses are both self-assigned
    the same way, and neither implies the result is never published or
    never recognized by an unrelated party. What actually distinguishes
    this tier from `100`–`999` isn't visibility, it's *authority*: no
    registry vouches for what a self-allocated ID means, so any
    cross-implementer recognition has to come from somewhere else — Type
    Hint's hash-derivation (§3.1) or App Route (§4.4), not a lookup
    table. It's only viable at all because the wire format never fixed
    Type IDs to a small byte-width field.
  Exact boundaries remain a policy decision for whoever ends up running
  the registry, not a wire-format one.
- **Even/odd for governance tier (considered, rejected):** reuse the
  even/odd convention itself to mean "pre-registered vs. free-for-all,"
  the same way it already means critical-vs-optional for keys (spec
  §3.2). Rejected for two reasons: it collides semantically with a
  convention that already carries a specific, different, load-bearing
  meaning elsewhere in the spec — a reader would have to track two
  unrelated meanings of "even/odd" depending on whether they're looking
  at a key or a Type ID — and it halves the usable ID space for no
  benefit a tiered range doesn't already provide more cheaply.

**Guidance, not a requirement: structured composition within the
private-use tier.** [GitHub issue #10](https://github.com/mofosyne/qdef/issues/10)
raised this after building against the tier as recommended: an
implementer defining several related Record Types MAY compose a
private-use Type ID as a random prefix plus a locally self-assigned
suffix (`TypeID = (prefix << suffix_bits) | suffix`), rather than
drawing an independent CSPRNG value for each one. Costs zero additional
wire bytes either way — the field is the same width regardless of how
its bits were chosen — and reduces the number of independent random
draws a single implementer needs to make from one per Record Type to
one per implementer.

Two things worth stating plainly if this gets used, not left implied:

- **Skew the split toward the prefix, not evenly.** Suffix demand for a
  single implementer is typically small (single digits to low tens of
  distinct Record Types), so the suffix should get the minimum obviously
  sufficient width, not a 50/50 split — every bit shifted to the prefix
  meaningfully improves the number that actually matters.
- **Effective collision safety is governed by the prefix width alone,
  not the full field width.** Suffix values will cluster around small
  sequential integers (`0`, `1`, `2`...) in practice, since that's what
  any implementer will naturally reach for. Conditional on two
  implementers' prefixes colliding, a full-value collision on a low
  suffix value becomes near-certain rather than merely possible — so a
  56-bit prefix gives *56-bit-class* safety, not 64-bit-class, and
  narrower prefixes should be sized off real numbers, not intuition: at
  10 million independent draws, birthday-bound collision probability is
  ~2.7×10⁻⁶ at 64 bits, ~6.9×10⁻⁴ at 56 bits, and already past 1 expected
  collision at 32 bits — 32-bit alone is not safe at any serious
  ecosystem scale.

**Scope note, corrected.** An earlier version of this note warned that
using a private-use Type ID for cross-implementer coordination was a
"widening" beyond the tier's scope, on the premise that the tier meant
closed/internal-only use. That premise was wrong (corrected above) —
self-allocation was never a promise to stay undiscovered, and Type
Hint's whole reason to exist (§3.1) is letting an unrelated implementer
recognize a self-allocated ID. So there's no widening to guard against
there.

The caution actually worth keeping is narrower and still real: if a
structured private-use ID's prefix starts getting treated as an
*implicit* cross-implementer routing signal — "anything sharing my
prefix is safe to auto-launch for" — that's quietly reinventing App
Route (§4.4) without App Route's domain-verified trust model behind it.
Use App Route explicitly when routing is the actual goal; don't let a
Type-ID-prefix convention become an accidental second routing channel
nobody decided to build.

## CBOR tag-number collision (resolved — the tag route was removed)

An earlier draft wrapped every Record Map in a CBOR semantic tag equal to
its Type ID (the "Smart Route"), alongside the mandatory key `0`. Found
broken on two independent grounds, not one:

- **Empirical.** CBOR tag numbers are a shared IANA registry (RFC 8949
  §3.4), and the low numbers QDEF's stdlib picked are already assigned:
  tag `2`/`3` are bignums, tag `4` is a decimal fraction, tag `5` is a
  bigfloat — exactly Types 2 (Split), 3 (Compress), 4 (Encrypt), 5
  (Fallback Hint). Type `100` (Wi-Fi) collides with RFC 8943's
  days-since-epoch date; tag `0` additionally makes Type ID `0` unusable.
  Reproduced against a real decoder, not just asserted: `Tagged(2, <byte
  string>)` decodes to a `BigInt`, and wrapping an actual Record Map in
  tag `0` decodes to `Invalid Date` — see FINDINGS.md #11.
- **Conceptual, and the deeper reason.** Even numbers with no *current*
  collision were the wrong fix, not just a smaller one. A tag number is
  meant to carry one predefined, universal interpretation (a byte string
  *is* a bignum, a text string *is* a date) that any implementation can
  look up and apply — not a private, per-application enumeration handed
  out in bulk. Treating "tag == Type ID" as QDEF's own extensible ID
  space was asking the registry to be something it isn't, independent of
  which specific numbers happened to be free. No legitimate registry
  grants thousands of slots to one application's internal dispatch
  table.

Key `0` was never implicated by either argument: there is no IANA registry
for map keys, only for tags, so a bare Record Map has no built-in semantic
layer for a generic decoder to misinterpret — verified directly
(FINDINGS.md #11): the identical Record Map round-trips cleanly when
untagged, and decodes to `Invalid Date` only when wrapped in a tag.
**Decision: the tag route is removed. Key `0` is the sole routing
mechanism** (spec §3.1) — simpler, and every prototype test already routed
through it alone, tag or no tag. The place a CBOR tag still legitimately
appears in QDEF is unrelated to routing: spec §3.2 allows any tag number
to wrap a field's own definite-length string value directly, a
Record-Type author's own opt-in choice about one field's content, which
is exactly the "predefined, universal meaning" use tags are for — not a
mechanism QDEF's core depends on. See "Field values may carry any CBOR
tag" below for why this widened from an initial tag-`24`-only rule. A
single shared
"this map is a QDEF Record" tag (the way
tag `55799` means "self-describe CBOR") was considered as a middle ground
and set aside for the same reason: one more optional mechanism to document
and implement, for a benefit key `0` already provides unconditionally.

## Field values may carry any CBOR tag, not just tag 24 — widened per FINDINGS.md #15/#16

Issue #8's original fix (FINDINGS.md #15) restricted the field-value-
shape rule's tag exception to tag `24` specifically, out of caution: it
was the one case already known to be both skip-safe and to have a real,
non-QDEF-specific meaning. Revisited once actually asked directly: what
does the rest of the IANA CBOR tag registry (tags under ~1000) actually
look like, content-shape-wise — is "only 24" doing real work, or just
being narrower than it needs to be?

Checked directly against the registry, not from memory: tags split
cleanly into two groups by their own RFC 8949 definitions. Genuinely
scalar- or string-shaped (dates, URIs, UUIDs, regex, bignums, base64/
base16 conversion hints, typed numeric arrays wire-encoded as byte
strings) versus genuinely array- or map-shaped by definition (decimal
fractions and bigfloats — a 2-element array; rational numbers; language-
tagged strings — `[language, text]`, easy to mistake for a bare string;
COSE structures; the "expected conversion" hints `21`–`23`, confirmed
directly against RFC 8949 to apply recursively over arbitrary structure,
not just a byte string). The *content-shape check* (definite-length
string, directly, never another tag) is what makes a tag skip-safe — that
holds regardless of which tag number is on the wire, so restricting to
`24` alone was stricter than the actual safety property required, and the
registry itself already sorts into the right buckets without QDEF needing
to maintain an allowlist of "safe" tag numbers.

Two things confirmed this wasn't accidentally reopening either hazard the
narrower rule was guarding against:

- **Not the recursion hazard.** The bound that matters is "tag content is
  checked to be a definite-length string directly, never another tag" —
  unrelated to which specific tag number is involved. Tag `24` wrapping
  tag `0`, or tag `0` wrapping tag `24`, are equally out of bounds; a real
  fixture (`STRUCTURED_TAG_WRAPPED_VALUE_CONTAINER`, tag `4` wrapping a
  genuine `[-2, 27315]` decimal-fraction array) proves a real, plausible,
  correctly-formed tagged value still gets rejected when its content
  isn't a string, same as any bare array would.
- **Not the private-enumeration hazard.** This isn't QDEF choosing or
  interpreting tag numbers for its own routing purposes the way the old
  Smart Route did (findings #11–#12) — it's letting Record authors use
  *real* IANA registrations for their own intended, standardized meaning.
  That's the correct use of CBOR tags per RFC 8949's own design
  philosophy, not a reopening of the mechanism that was removed.

## Type Hint (Key 1): folding into key 0 instead — considered, rejected

An alternative to reserving key `1` globally was considered: fold the hint
into key `0` itself (making it sometimes a compound value instead of a
bare uint) so key `1` stays free for each Record Type's own use. Rejected:
key `0` is the one field read unconditionally for *every* Record,
including ones about to be skipped, so complicating its shape reintroduces
exactly the recursion-adjacent cost the field-value-shape rule (spec §3.2)
eliminated, on the single least-skippable code path in the format. It also
isn't additive — every existing implementation (including this repo's own
Rust prototype) hard-codes "key `0` is a uint," so redefining it would
break every parser written against the spec today. Reserving key `1`
instead costs only one non-critical, per-Type-unbounded integer — every
parser already implements "skip an unrecognized odd key" as baseline
behavior, so the tax is paid once, in the spec text, not repeatedly at
runtime by implementations that don't care about it.

## Media Payload (Type 6): why it does *not* reuse Type Hint's decentralized-ID pattern

The first draft of spec §4.3 copied Type Hint's decentralized-ID + Hint +
opportunistic-hash-verify pattern (§3.1, above) onto Media Type wholesale
— same mechanism, one layer down. That turned out to be a mistake worth
recording, not just quietly fixing: it mechanically reapplied a pattern
without checking whether the problem it solves was even present at this
layer.

**Type ID and Media Type are not the same shape of problem.** A
private-use-random Type ID has *no* identity besides the number — that's
exactly why Type Hint has to exist (to attach a name) and why the hash
check has to exist (to prove that name wasn't tampered with). A media
type isn't like that: `"text/vcard"` is already a stable, globally
meaningful string, defined by RFC 6838's own Media Types registry,
completely independent of whether CoAP ever assigned it a compact number.
CoAP's numeric registry is a compactness shortcut for the popular cases,
not the source of a media type's identity. So when a media type isn't in
CoAP's table, there's no opacity to resolve — the plain string already is
the recoverable name, with nothing left for a Hint field or a hash check
to add. Settled on the simpler two-form design instead: a CoAP uint when
registered, the plain MIME string otherwise, nothing else.

This also answers a question worth asking directly: does CoAP itself have
a private-use/decentralized tier the way QDEF's Type ID does? No — its
tiers are Expert Review, IETF Review, First-Come-First-Served, and a small
Experimental range explicitly barred from real use ("MUST NOT be used in
operational deployments"), never a "pick a large random number, no
registration needed" escape hatch. Partly structural (Content-Format is a
16-bit field in the CoAP wire protocol itself, so there's only 65536
numbers total — too few for uncoordinated random self-assignment to be
collision-safe), but more fundamentally because media types don't need
one: they already have external, stable names outside CoAP's registry.
QDEF's own Type ID tier needs a private-use escape hatch because Type IDs
have no other identity; media types already do.

**Relying on CoAP's registry at all is a conditional choice, not a
default.** It's justified specifically because that registry has good
prospects of staying maintained — IANA-run, IETF-governed, updated as
recently as 2025 (RFC 9876) — not merely because some external numbering
scheme happened to exist. Spec §4.3 asks adopters to keep a periodic
mirror of the table regardless, so QDEF's ecosystem isn't stranded if that
maintenance prospect ever turns out to be wrong.

## Standard library governance

Related but narrower (spec §4): who maintains the reserved `1`–`99` range
itself — additions like §4.1/§4.2/§4.3 need some process for becoming
part of "the stdlib" rather than just another vendor's Record Type
squatting on a low number.

## Magic-header overhead for QR

5 bytes fixed cost matters for a single-record payload in a
size-constrained QR version; is it worth gating on payload size (e.g. omit
magic when embedded via a scheme that already identifies the format,
mirroring the NFC case in spec §2)? A real data point from an adopter
comparison (verified directly against `mofosyne/tagdrop`'s SPEC.md):
TagDrop's native envelope costs 2 bytes total (`version`+`type`, both
small CBOR uints, SPEC.md §2), against roughly 10–15 bytes for QDEF's
magic+version+map-framing overhead (key `0` plus key `2`'s length header)
on the same small payload — a large proportional cost for TagDrop's
smallest codes (a short text snippet can be under 50 bytes total).
Doesn't change the conclusion elsewhere in the spec that QDEF wrapping
stays strictly opt-in, never the default framing (spec §6, §7) — but it's
a concrete number to weigh if the conditional-magic-header idea above is
ever worth building.

## Relationship to existing standards

NDEF already solves "multiple typed records, one message" for NFC (spec
§2's `application/vnd.qdef` MIME framing leans on this directly). This
draft's actual net-new contribution is narrower than it first appears: a
*magic-header-plus-CBOR-Sequence* convention for the optical/QR case
specifically, plus the even/odd criticality rule, which NDEF itself does
not have (NDEF has no per-key criticality signal at all, only per-record
TNF/Type). The closest shipped analog for the QR case specifically is
[BBQr](https://bbqr.org/BBQr.html) (magic header + single-char file-type
byte + QR-series splitting, used for Bitcoin PSBTs/transactions) — but it
identifies exactly one file type per *entire QR series*, not multiple
heterogeneous Records within one payload, has no per-field criticality or
versioning signal, and encodes alphanumeric rather than native byte-mode.
QDEF's multi-Record-per-payload model and even/odd rule are real deltas
against it, not restatements. The general "magic bytes + sequence of
self-describing typed records" pattern itself is well-proven elsewhere
(e.g. [MCAP](https://mcap.dev/spec) for robotics data logs) — QDEF's
contribution is applying it to the constrained-optical-scanner case, not
inventing the pattern. The idea itself predates this repo: `mofosyne/tagdrop`
issue [#16](https://github.com/mofosyne/tagdrop/issues/16) (2016) proposed
an NDEF-like binary header for QR codes a decade before this draft
existed; QDEF is the first attempt to actually build it out.

## Why not just carry a literal NDEF message as the QR byte-mode payload, instead of a new format?

It's technically possible — nothing stops encoding actual NDEF bytes into
a QR code — but it wouldn't actually avoid inventing anything, for three
concrete reasons. First, byte economics: NDEF's Type field is a URN, MIME
string, or `domain:type` string (TNF_WELL_KNOWN/MIME_MEDIA/EXTERNAL_TYPE),
so every record pays bytes proportional to a string's length for its type
tag, where QDEF's Type ID is a CBOR uint (often 1–3 bytes) — the same
economics argument as the magic-header-overhead entry above, one layer
deeper. Second, a structural mismatch: NDEF's chunk flag (CF) solves "this
record's payload is bigger than one read from a continuous tag session" —
chunk continuation requires TNF `0x06` and zero Type Length on every
middle chunk, a scheme that assumes one uninterrupted message stream. It
does not solve "this message is spread across several independently-
scanned physical codes, any one of which might fail to scan," which is
what spec §4.1's Split Wrapper (with XOR parity, fragment-loss recovery)
actually addresses — reusing NDEF's envelope wouldn't provide that
mechanism at all. Third, granularity: NDEF's TNF/Type gets you
record-level dispatch only — nothing inside an NDEF payload has any
per-field optional/critical signal, so an adopter would still need to
invent their own internal structure for "which fields are safe to
ignore," which is exactly what spec §3.2's even/odd rule already is.
Wrapping literal NDEF bytes would add NDEF's tag-session-oriented framing
(MB/ME message-boundary flags, meaningless for a payload delivered
atomically in a single scan) on top, without saving QDEF's actual
contribution.

## Encrypt key provisioning (resolved — Algorithm/Key Algorithm fields, borrowing COSE)

Type 4 originally named a cipher only in a comment (`e.g. AES-GCM`), with
no field for it, and never specified where the key comes from at all — see
FINDINGS.md #6 for how the prototype surfaced this. Considered leaving it
out of scope entirely (an application-layer concern) versus adding a
field; resolved toward a field, but not a QDEF-specific one.

The same asymmetry check that killed Media Type's decentralized-ID layer
applies here identically: a cipher and a key-agreement scheme are both
things with a stable identity independent of QDEF, so there's no opacity
problem for a hint-plus-hash layer to solve — just borrow an existing
numbering scheme, the same playbook as Media Type. The fit is even
tighter than CoAP was for Media Type, because it's the same domain:
IANA's COSE Algorithms registry (RFC 9053/9054) already covers both the
content-encryption algorithm and the key-agreement/wrap/derivation
algorithm, is CBOR-native (COSE structures are CBOR), and is actively
governed with the same tiered structure QDEF's own Type ID space uses.

Spec §4.1 adds two optional fields to Type 4 (key `5` Algorithm, key `7`
Key Algorithm — a COSE Algorithm ID or a plain string, encoder's choice)
and keeps both odd/optional rather than critical, deliberately matching
`parity_scheme`'s precedent over nonce/ciphertext's: two apps that already
agree out of band (§8's worked example) pay nothing, and a decoder that
doesn't recognize either field just falls back to its own assumption,
which fails safely regardless since AEAD's own auth tag catches a
wrong-algorithm attempt. The fields exist specifically for the
interoperable-key-transfer case an unrelated adopter would need — flagged
during a discussion of what "QDEF spreading to more QR apps" would
actually require in practice, not a hypothetical gap.

Worth flagging as an implementation caution, not a wire-format concern:
a decoder that *does* honor these fields must not let them broaden which
algorithms it's willing to run — the same "alg" confusion vulnerability
class JOSE/JWT is known for. Treat the value as something to check against
an application-chosen allowlist, never as an instruction to trust
outright.

**Checked against a real adopter after the fact, surfacing a limitation
worth keeping:** `mofosyne/tagdrop` uses AES-256-GCM (exact match for
`A256GCM` = 3, confirming the cipher-ID choice) and PBKDF2 for
passphrase-based key derivation — the latter has no COSE algorithm ID at
all (COSE's key-derivation entries are all HKDF variants), so Key
Algorithm's plain-string fallback covers this case, not the numeric one.
More significantly, TagDrop's encryption is deliberately *undeclared* —
"discovery, not declaration," confirmed via trial decryption rather than
a stated algorithm, specifically so ciphertext stays indistinguishable
from random. A Type-4 Wrapper can't preserve that regardless of field
shape: being wrapped in Type `4` at all is itself a visible declaration to
any QDEF-aware parser walking the Sequence. See FINDINGS.md #13 for the
full reasoning — a genuine, principled scope boundary, not a gap to close,
and confirmation that TagDrop's own §6 registration (encryption entirely
inside the opaque blob, invisible to QDEF) was already the right call.

## Media Payload: checked against a real adopter, confirmed compatible but never reached

`mofosyne/tagdrop` does have typed content-tagging (`mime_type`, a
free-form string, never a numeric ID) — confirming that if this were ever
exposed at the QDEF layer, it would use Media Type's plain-string
fallback, not CoAP's numeric registry. But it can't come up for TagDrop's
actual §6 registration at all: that registration already carries TagDrop's
entire existing CBOR sequence (`mime_type` included) as one opaque blob
under a single key, deliberately invisible to QDEF by the same reasoning
§7 settled for compression and splitting generally. Not a gap — Media
Payload was never going to be reached by an adopter whose own format is
already opaque to QDEF by design; it's aimed at an adopter with no
existing format of its own to protect (§1's "when QDEF earns its place").

## Split chunking vs. per-code capacity — costs nothing against at least one real adopter's design, general case still open

The uniform `chunkLen = ceil(total_bytes/count)` rule (spec §4.1) is what
makes single-fragment XOR parity well-defined, but it also prevents an
encoder from sizing each fragment to match that specific code's actual
capacity (different QR version/ECC level per code, or a QR code alongside
a smaller-capacity NFC tag in the same group). Checked against a real
adopter rather than left as a hypothetical concern: `mofosyne/tagdrop`'s
own sectorization already assumes uniform chunk length across a split
group (every sector but the last is the same length, per its own spec —
verified directly against `mofosyne/tagdrop`'s SPEC.md), so QDEF's
uniform-chunking rule matches what that adopter's format already does
rather than imposing a new constraint on it. That's evidence for one real
usage pattern, not a general resolution — an adopter that genuinely needs
heterogeneous per-code capacity within one group (the
QR-alongside-smaller-NFC-tag case) still hits this constraint. Resolving
that general case still needs either accepting uniform-chunking as a real
limitation, or specifying a fragment-length manifest redundant enough to
survive one missing fragment. See FINDINGS.md #3.

## Canonical encoding (resolved — spec §3.4)

Spec §4.1's `group_id` was a hash of encoded bytes that silently assumed
two conformant encoders given the same logical content produce identical
CBOR — true only because every worked example used simple, unambiguous
field values. CBOR permits multiple valid encodings of the same value
(e.g. an integer encoded with a longer-than-necessary argument width, or
a map with keys in a different order), so this wasn't automatically true
in general, and matters more the moment QDEF is used for hashing/signing
beyond `group_id`'s narrow use (spec §8's PGP-backup example already sits
right next to that use case, and any future Sign mechanism below depends
on it entirely).

Resolved by adopting CBOR's own deterministic-encoding rules (RFC 8949
§4.2.1 — shortest-form arguments, no indefinite-length items, map keys
sorted in bytewise lexicographic order of their encoded bytes) as a MUST
for encoders — nothing QDEF-specific invented, the same borrow-don't-
invent instinct as everywhere else in this document. Distinct from, and
not solved by, the field-value-shape rule (spec §3.2), which constrains
*what shape* a value may be, not which of several valid *encodings* of
that shape an encoder must pick — the two rules are complementary, not
overlapping.

Worth being precise about what was and wasn't actually broken: `group_id`
verification was never *incorrect* for its narrowest existing use (a
single encoder hashes bytes it's about to fragment, a decoder reassembles
and re-hashes the identical bytes — pure corruption detection, unaffected
by canonicalization either way). What canonical encoding actually fixes is
the *stronger* property `group_id`'s own spec text already implicitly
claimed — "content-addressed... no coordination is needed between
independent encoders" only holds if independent encoders of equivalent
content produce identical bytes, which nothing guaranteed before this
rule existed. Closed proactively, before Split/group_id saw real
production traffic, rather than after a cross-encoder mismatch surfaced
one in the field.

## Sign / detached-authenticity wrapper (new, requested)

There is no way today to prove a *plain, readable* Record is authentic
without also hiding it: the Encrypt wrapper's AES-GCM tag provides
integrity only as a side effect of confidentiality, and there is no
standalone sign primitive. Adding one is not the clean parallel to Encrypt
it first looks like, and that is the finding:

- **Sign-as-wrapper (opaque form).** Mechanically identical to Encrypt
  (Type 4) — the signed Record's bytes become the wrapper's opaque
  payload, plus a signature/MAC field. It inherits Encrypt's visibility,
  though: an unaware parser skips the whole thing and sees *nothing*. That
  is fine only when the inner Record was going to be opaque anyway (a
  Type-950 key backup, a proprietary blob), where it *is* a clean
  parallel. It cannot achieve "sign a Wi-Fi record and keep it readable" —
  being readable and being a wrapper payload are mutually exclusive.
- **Sign-as-sibling (detached form).** The signature is a *separate*
  Record (like the Fallback Hint spec §4.2 is a sibling, not a wrapper),
  carrying a reference to which Record(s) it covers plus the signature
  bytes. The signed Records stay plain and readable; an unaware parser
  reads them normally and skips the unrecognized signature Record by Type
  ID. This is the form that delivers "readable *and* verifiable" — but it
  depends on two things: **canonical encoding** (spec §3.4, now resolved
  above — a verifier must reconstruct the exact signed bytes) and a
  **coverage-identification scheme** (which Records, addressed how — by
  index? by content hash? — surviving reordering and unrelated siblings,
  still open). Coverage identification is the same signed-bytes/verified-
  bytes divergence hazard this project's origin story (TagDrop's signing
  bug) is a caution about, so it must not be hand-waved.

**Coverage-identification scheme — direction decided, not yet built.**
Cover by content hash of each covered Record's own canonical bytes, never
by Sequence index: an index breaks the moment anything is reordered or an
unrelated Record is inserted, while a hash doesn't care where a Record
sits. This also reuses the canonical-encoding machinery `group_id` already
needs (above) rather than inventing a second addressing concept. Two
refinements this needs to get right, both surfaced by checking the
proposal against rules already settled elsewhere in the spec rather than
taking the shape on faith:

- **The hash list MUST be a packed, fixed-width byte string, not a bare
  CBOR array.** Spec §3.2's field-value-shape rule forbids a bare array as
  a field value — `N` concatenated 32-byte SHA-256 hashes in one
  definite-length byte string (skip-safe, decoded by whatever
  Sign-Record-aware handler chooses to) is the compliant shape; a naive
  CBOR array of hashes is not, and a conformant core parser would reject
  it outright (spec §3.3).
- **A hash covers a Record's fully unwrapped, reassembled canonical
  bytes — never a Wrapper's per-fragment or per-code bytes.** Hashing
  Split-fragment bytes directly would make a signature depend on how many
  physical codes the content happened to be fragmented into, an
  implementation/transport detail with no business affecting whether a
  signature verifies. Sign a Record after any Wrapper stack resolves, the
  same layer `group_id`'s own hash already operates on.

Strippable-but-not-forgeable is an accepted property of this design, not a
gap to close: deleting a sibling Sign Record from the Sequence downgrades
signed to unsigned, trivially, the same way `mofosyne/tagdrop` already
documents "signature can be stripped but not forged or retargeted" as an
accepted limitation of its own scheme (§6) rather than something it
structurally prevents.

Direction when taken up: specify the sibling form (it is the one worth
having), but only *after* the canonical-encoding question is resolved — a
detached signature is meaningless without it. The wrapper form can be
dropped in at any time as a straight parallel to Encrypt if an
opaque-payload use case ever wants it. Prototype it the same way
everything else here was: sign two sibling Records, reorder them, insert
an unrelated third Record, and confirm verification still finds exactly
the right two — the sort of end-to-end check that catches what design
review alone doesn't (see FINDINGS.md).

## Nesting order enforcement — now answered, not open

A prototype confirmed a generically-written decoder cannot detect or
reject a non-conformant Wrapper nesting order (FINDINGS.md #7); spec
§4.1's text has been corrected accordingly. This entry is resolved and
kept here only as a record of the change from the prior draft's "leaning
toward" language.

## Type ID inheritance within a Sequence — backlog, needs a version bump

Raised alongside [GitHub issue #10](https://github.com/mofosyne/qdef/issues/10):
allow a Record's Type ID (key `0`) to be omitted, meaning "same Type ID
as the immediately preceding Record in this CBOR Sequence" — a wire-
efficiency optimization for adjacent same-type Records with a wide
private-use Type ID (the repeated calendar-event case in
`IMPLEMENTATION-NOTES.md` is exactly this shape).

Not something this draft can add as a plain additive extension the way
everything else in this document was. Spec §3.1 already defines a
missing key `0` as a MUST-abort condition — redefining that meaning is a
behavior change to already-shipped semantics, not an addition, so two
decoder versions would interpret identical bytes differently depending
on which one they implement. That's exactly the class of change spec §2
reserves the Version byte for ("a future version is free to change...
the routing rules... themselves"), not something to introduce via the
odd-key extensibility path the way Type Hint, Media Payload, and the
tag-24 generalization all were.

Scope, resolved as a side effect of a separate discussion (checking
issue #10's cross-code repeated-Type-ID cost against this idea): "the
immediately preceding Record" can only ever mean within one Sequence —
there's no cross-code Record continuity in the format at all, since each
physical code is parsed as its own independent container from a blank
slate. This means the mechanism would help intra-Sequence repetition
(the calendar-events case) but not cross-code repetition (issue #10's
motivating Preview cost) — worth being clear these are two different
problems with two different possible fixes, not one problem with two
names.

Backlog, not urgent: tracked for whenever a version bump happens for
some other reason, not a reason to force one on its own.

## Reference/value-sharing tags for intra-Sequence repetition — future path, not built

A related idea to Type ID inheritance above, raised while looking for a
general fix to repeated-large-value wire cost: CBOR already has
registered tags for exactly this — tag `25` ("reference the nth
previously seen string") and the pair `28`/`29` ("mark value as shared" /
"reference nth marked value," content a plain uint index). Checked
directly against the IANA registry, not assumed. Mechanically skip-safe
under one more small widening of the same rule generalized twice already
(§3.2, FINDINGS.md #15/#16) — a tag wrapping a scalar directly is exactly
as bounded as a tag wrapping a string, since the mandatory core only ever
needs to skip the reference, never resolve what it points to; resolution
is Record-Type-specific, optional work, same as unwrapping any other
opaque content.

**Doesn't solve the problem that motivated it, and that's worth being
explicit about rather than letting the idea imply otherwise.** A
reference requires shared decode state across everything it reaches
into; two physical codes have none — each is parsed from a blank slate,
in any order, with any of them possibly missing. So this hits the exact
same wall as Type ID inheritance above, for the identical structural
reason: it could only ever help repetition *within* one code's Sequence,
never App Route's or Preview's cross-code repetition, which is the cost
that actually prompted looking for a fix.

Where it would genuinely help: the same large value repeated multiple
times within one code — e.g. `IMPLEMENTATION-NOTES.md`'s calendar Option
B (several sibling Records, same wide private-use Type ID, all small
enough to sit on one code without needing Split). Real, but narrower
than "wire bloat" as originally framed, and it comes with cost beyond the
rule-widening: precise scope rules for what counts as "the stream" a
reference can reach into (one Record's map? the whole Sequence? does a
Wrapper's unwrapped content restart it?), and weaker real-world tooling
support than tag `24` had — tags `25`/`28`/`29` come from an informal
spec (schmorp.de's stringref/value-sharing drafts), not RFC 8949 proper,
so "generic CBOR tooling already reads this" is a much weaker claim here.

Not built. Noted as a future path specifically for the single-code
repetition case, not a general wire-bloat fix — worth a concrete same-
code case actually hitting this before adding the complexity, same
discipline as everything else deferred in this document.

## App Route's decentralized form — a second use case surfaced late, not a second mechanism

The domain-verified form of App Route (§4.4, FINDINGS.md #17) was built
to answer one question: which installed application should this scanned
code auto-launch. Working through GitHub issue #10 with TagDrop surfaced
a second, genuinely different question that key `2` also turns out to
answer well: *before* attempting reassembly at all, is this scanned code
even plausibly part of the group the scanner thinks it's building —
cheap, per-code triage against a misread or an unrelated nearby code,
layered ahead of §4.1's `group_id` integrity check rather than
duplicating it.

These two questions have different stakes, and conflating them would
have been the actual design error. Auto-launch dispatch is a
security-relevant decision — get it wrong and the wrong application
opens, so it needs the domain form's real, platform-verified ownership
proof (Android App Links / iOS Universal Links). The pre-filter is not
security-relevant — get it wrong and a decoder wastes a little effort
before `group_id` catches the mismatch anyway, exactly the same outcome
as not pre-filtering at all. That gap in stakes is *why* the
decentralized form is allowed to reuse Type Hint's cheaper,
unauthenticated pattern (a private-use-random uint at key `2`, an
optional recoverable name at key `3`) instead of requiring domain
verification for both — it would be a mistake to make the pre-filter pay
the domain form's registration cost for a property it doesn't need, and
an even bigger mistake to let the pre-filter's weaker guarantee quietly
become load-bearing for dispatch.

Concretely this is the same "magic byte" idea raised earlier in this
project's history (see the ref-pointer/wire-bloat discussion above),
given a specific pre-filter role instead of staying an abstract
possibility. Landed as one Record Type with two forms rather than a new
Record Type, since the wire shape, skip behavior, and Type Hint's
name-binding pattern are all identical; only the trust model and the
etiquette guidance around repetition differ (§4.4).

## The container header collapsed to magic + a CBOR Sequence, full stop

What started as "can the header carry an optional format namespace for
fast identification" ended somewhere more radical: there is no longer a
distinct header structure at all. The container is `QDEF` (4 bytes) plus
a CBOR Sequence of Records — nothing else, ever. Record Type `0` is
reserved for what used to be header-level metadata (spec §3.5), but it's
an ordinary Record, decoded by the exact same code path as any other
Type, not a second wire structure living alongside the Sequence.

Getting there took several real corrections along the way, worth naming
because each one fixed something that would have been a genuine
inconsistency if it had shipped:

- **A fixed-width raw namespace field, then a mandatory CBOR-uint one,
  both rejected in favor of an ordinary optional Record.** Both earlier
  shapes taxed every container that didn't use the mechanism at all (5,
  then up to 13 bytes, always paid). Landing it as a plain odd/optional
  key on Type `0` means a container using only known Type IDs pays
  *nothing* — not even one byte — the same "unaware party pays nothing"
  property every other stdlib mechanism already has.
- **"Different Type ID = different header version" was a real mistake,
  caught directly, not just a style preference.** It wasted low Type ID
  space on hypothetical future header revisions and was inconsistent
  with how every other stdlib Record actually evolves here (Encrypt and
  App Route both gained fields on their *existing* Type IDs, never new
  Types, when real needs showed up later). Corrected: Type `0` is the
  one, permanent header Record; a genuinely incompatible future change
  is just a new even/critical key on it, whenever actually needed —
  even/odd extensibility already *is* the version mechanism, no
  dedicated field required.
- **Key `1` was briefly considered for a "version code" field and
  rejected once the collision was spotted.** Key `1` is already,
  globally, Type Hint (§3.1) — for a Type ID below `0x10000` (which `0`
  is), it specifically means "the legacy ID this Type was promoted
  from." A generic Type-Hint-aware decoder would have actively
  misread a version integer sitting there as a bogus legacy-ID claim,
  not just ignored it. No field ended up needed there at all, so the
  question resolved itself, but the near-miss is worth recording: reusing
  an already-load-bearing key for a second, unrelated purpose is exactly
  the mistake this project already rejected once before, for even/odd
  itself (see "Registry governance," above) — worth catching a second
  time rather than assuming it wouldn't recur.

**Why the version byte itself is gone, not just smaller.** The old
container-level version byte existed to gate *any* future change to the
framing — a necessarily blunt, all-or-nothing tool, since a decoder has
no way to know in advance which future changes a version bump will
cover. §3.2's even/odd rule already solves this more precisely for
ordinary Record evolution (skip an unrecognized Type, ignore an
unrecognized odd key, abort just one Record on an unrecognized even
key). The only gap left was safety for changes to the outermost framing
itself — and Type `0` closes that gap using the identical mechanism,
just aimed one level further in, rather than needing a cruder,
separate all-or-nothing tool bolted on top of it. One extensibility
story for the whole format, not two.

Format namespace values reuse Type ID's own four-tier convention (§9's
Registry governance) rather than inventing a second, parallel governance
scheme — the same collision-safety math that makes a large random Type
ID viable without a registry applies identically to a namespace value.

Prototyped end to end: `prototype/src/header.js` and
`prototype/test/header.test.js` on the Node side, and
`rust/qdef-core`'s `record_type_0_needs_no_special_handling_from_this_crate`
test proving the claim in the name directly — the Rust mandatory core
required zero new code to handle Type `0` correctly, only a fixture
proving it.

**Consequence: App Route's Companion ID (key `5`) is removed, not kept
alongside this.** Companion ID existed for exactly one job — a cheap,
per-code misread pre-filter — and the namespace field now does that job
better: structurally guaranteed first (Companion ID lived on App Route,
which is explicitly *not* positionally special, so a scanner had to
find it), and genuinely zero-cost when unused (Companion ID required a
whole separate decentralized-form App Route record on every sibling
code). Keeping both would have meant two private-use-random-plus-Hint
mechanisms answering the same question from two different Record Types
— exactly the kind of duplication this project avoids elsewhere (see
"Registry governance," above, on not inventing a second governance
scheme where one already fits). Nothing shipped yet, so this was a
clean removal rather than a deprecation: §4.4's domain form and plain
decentralized form are back to their pre-Companion-ID shape, and the
domain form's key `3` is a label again, not unified with the
decentralized form's Hint-name role — that unification's only real
justification (letting Companion ID be hash-checked) is gone with it.

## Namespace-scoped Type IDs (100+) — resolved, not left open, once a real adopter had a concrete want

§3.5's namespace mechanism launched with one deliberate gap: whether and
how Type IDs `100`+ become namespace-local once a namespace is declared
— the original truncation idea that motivated building a namespace
mechanism at all — was left unresolved, on the theory that landing
identification cleanly mattered more than guessing at a scoping rule
nobody had asked for yet. TagDrop asking directly, with a concrete want
(shrinking four existing 64-bit Type IDs) rather than a hypothetical
one, was exactly the signal this project has waited for before building
speculative things — the same pattern that produced App Route and,
later, its own removal.

**The resolution reuses the existing flat numbering space; it doesn't
carve out a new one.** Once Type `0` declares namespace `N`, a
subsequent Record's Type ID `T` (`T ≥ 100`) is looked up as the compound
key `(N, T)`, not `T` alone — the same relationship a Bluetooth short
UUID has to whichever Base UUID it's declared against. This was the
crux design question, and the reason it took real thought rather than a
quick answer: the obvious alternative (reserve a new numeric sub-range
exclusively for namespace-local IDs) risks collision with whatever's
already been allocated in the existing tiers, and doesn't actually need
solving once you notice that a *compound* key removes the ambiguity
structurally — `T` in isolation was never the real lookup key once a
namespace is present, so there's nothing for a reserved range to
protect against colliding with.

**The one sharp edge, named explicitly rather than glossed over:** a
decoder that implements specific semantics for any `100`+ Type ID and
does *not* check for a declared namespace first can misapply its global
interpretation to a namespace-scoped Record that merely shares the same
number — a wrong match, not a clean miss, which is a worse failure mode
than anything else in this spec produces. Nothing forces this check
today (nothing has shipped), so it's being written into the correct
definition of `100`+ routing from the start rather than patched in
later. Framed the same way Type Hint's dual-mode key `1` already is:
Record-Type-interpretation-specific handling (spec §3.3's optional
tier), never a mandatory-core concern — the mandatory core still just
reads `map[0]`, unchanged, with zero namespace awareness.

**Fully additive.** An app's existing global private-use-random Type
IDs keep working forever; adopting namespace-scoped small IDs for new
content is an independent, opt-in choice that never invalidates or
collides with the old ones, since an unnamespaced old ID was never
namespace-scoped to begin with.

Prototyped in `prototype/src/header.js`'s `resolveLookupKey` and
`prototype/test/header.test.js`: the same Type ID resolving to different
compound keys under different namespaces, `1`–`99` staying global
regardless, a namespace-aware dispatcher correctly *not* falling back to
a recognized global meaning for an unrecognized namespace-scoped Record
(the sharp edge, demonstrated rather than just described), and
TagDrop's actual migration case end to end — verified real byte
counts, not claimed ones: an existing 64-bit global Type ID costs 11
bytes as a bare Record; a namespace-scoped small ID costs 4.

## A confession (Parkinson's Law of Triviality, self-reported)

C. Northcote Parkinson's original example: a committee approves a
multi-million-pound nuclear reactor in about two minutes, then spends
forty-five debating the design of the bike shed. This repo is not immune.
Removing the entire CBOR-tag routing mechanism — a genuine architectural
reversal, half the core's routing model gone — took exactly one finding
(FINDINGS.md #11) and one commit. Deciding whether a single reserved map
key's decentralized-ID hint belonged on key `1` or key `3` took a
multi-message negotiation, a rejected alternative design, and its own
section above. Draw your own conclusions about which of those two
decisions actually mattered more, and which one got more words spent on
it in this very document.
