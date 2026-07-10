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
  - `0x10000`+: **private-use, via a large random value, not a
    registry.** This tier needs no allocation authority at all: because
    Type IDs are CBOR uints with no fixed width, an implementer who picks
    a sufficiently large (e.g. 32- or 64-bit) *random* number gets
    collision avoidance from the sheer size of the number space, the same
    way a UUID does — not from anyone checking a list. This is the
    correct answer for closed/internal Record Types that will never be
    published or need to interoperate with an unrelated implementer, and
    it's only viable because the wire format never fixed Type IDs to a
    small byte-width field.
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
through it alone, tag or no tag. The one place a CBOR tag still
legitimately appears in QDEF is unrelated to routing: spec §3.2's optional
tag-24 hint on a field's own byte-string *value*, a Record-Type author's
own opt-in choice about one field's content, which is exactly the
"predefined, universal meaning" use tags are for — not a mechanism QDEF's
core depends on. A single shared "this map is a QDEF Record" tag (the way
tag `55799` means "self-describe CBOR") was considered as a middle ground
and set aside for the same reason: one more optional mechanism to document
and implement, for a benefit key `0` already provides unconditionally.

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
