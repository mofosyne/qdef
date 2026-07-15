# Prototype findings: what round-tripping actual bytes found

The QDEF design (`docs/QDEF-SPEC.md`) went through several rounds of prose
review before any code existed. This document records what changed once a
[throwaway Node prototype](../prototype) actually encoded and decoded QDEF
containers — the four scenarios required were: a plain Record, a
wrapped-third-party-payload Record, a full Split(parity)→Encrypt→plain
Wrapper Record stack with fragment loss/recovery, and the even/odd
criticality rule. All four round-trip correctly; the value was in what
building them forced the design to actually decide.

Nothing here is catastrophic — the core shape of the design holds up. But
"holds up" required making several decisions the prose left implicit, and
one place where the prose's own stated rationale turned out to be
overstated. That's the actual point of building this: prose review can't
surface either kind of gap.

## Fixes folded back into the spec

### 1. Hardware Parity: what happens when the tag and key 0 disagree? (historical)

§3.1 originally said a Record's CBOR tag and its `map[0]` carry "the *same*
ID" but never said what a decoder should do if they don't — e.g. a Record
tagged `105` whose `map[0]` says `100`. Left unspecified, a tag-aware
decoder and a constrained (key-0-only) decoder could each read a *different*
Type ID out of the identical bytes, silently disagreeing about what the
Record even is.

**Fix (historical):** a tag/key-0 mismatch was a hard abort of that Record
(same class of failure as an unrecognized critical key) — verified in
`prototype/test/core.test.js`.

**Later superseded:** the tag route and key-0 routing this finding is about
no longer exist — see finding #12. Routing is now via prefix typeIDs. Kept
here as an accurate record of what shipped at the time; the mismatch case
it fixed is moot once both routes were removed.

### 2. A Record with no prefix typeIDs at all (historical)

Not addressed anywhere when key 0 was the routing mechanism. Prefix typeIDs
are now how *every* parser routes a Record, so a Record missing its prefix
can't be routed by anyone.

**Fix (historical):** treat a missing prefix typeID the same as an
unrecognized-critical-key abort of that Record.

### 3. Split's fragment-chunking algorithm doesn't exist in the spec

§4.1's Type-2 example shows the *fields* of a Split fragment (`group_id`,
`index`, `count`, `fragment bytes`, `total_bytes`, `parity_scheme`) but
never says how the original bytes get sliced into fragments in the first
place. That's invisible right up until you need two independent
encoders/decoders to agree on it — which `parity_scheme` does, immediately:
XOR parity needs every fragment zero-padded to a common length before
XOR'ing, and recovering a missing fragment needs to know *that fragment's*
true length, which nothing in the spec provides if it's simply absent.

**Fix applied in the prototype:** fixed, deterministic chunking —
`chunkLen = ceil(total_bytes / count)`, fragments sliced sequentially, last
fragment shorter if `total_bytes` isn't an exact multiple of `count`. Any
two independent implementations that follow this formula agree without
coordination — the same content-addressing goal `group_id` already serves.

**Real tradeoff this exposes, left as an open question (see below):**
uniform chunking is what makes single-fragment XOR recovery well-defined,
but it's also *less* flexible than what a real encoder probably wants —
different physical codes (different QR versions/ECC levels, an NFC tag with
a smaller capacity than a QR sibling) plausibly need different-sized
fragments, chosen per-code rather than by one global formula. Uniform
chunking and per-code-flexible sizing are in tension, and the spec needs to
pick one (or specify a length manifest that survives a missing fragment) —
it currently does neither.

**Update:** checked against a real adopter rather than left purely
hypothetical — `mofosyne/tagdrop`'s own sectorization already assumes
uniform chunk length within a split group (verified directly against
`mofosyne/tagdrop`'s SPEC.md), so this tension doesn't cost that
adopter anything; QDEF's rule matches what its format already does. That's
evidence for one usage pattern, not a general resolution — see
DESIGN.md's updated entry.

### 4. `total_bytes` (key 9) is documented OPTIONAL but isn't, once `parity_scheme` is set

§4.1 frames `total_bytes` as a nice-to-have (progress bars, buffer
pre-sizing) and deliberately gives it an odd/optional key number. That's
correct for the no-parity case — plain reassembly is just "concatenate
fragments `0..count-1`, whatever lengths they carry." But the moment
`parity_scheme` is set and a fragment is actually missing, the decoder
*must* know that missing fragment's exact byte length to correctly truncate
the XOR-recovered, zero-padded result — and (given fix #3's uniform
chunking) that length is only derivable from `total_bytes`.

**Fix:** `total_bytes` stays an odd/optional *key* (the even/odd wire rule
is unaffected — an old decoder that doesn't understand key 9 should still
ignore it, not abort), but Type 2's own Record-Type definition now states:
`total_bytes` MUST be present whenever `parity_scheme` is present. This is
a Type-2-specific validity constraint, not a change to core criticality
semantics — verified by `splitDecode` refusing to guess in
`prototype/src/wrappers.js`.

### 5. `group_id` is content-addressed — the spec should say decoders MUST verify it

§4.1 already explains *why* `group_id` is a content hash rather than an
issued serial (no coordination needed between independent encoders). What
it doesn't say: that same hash is a free integrity check after reassembly,
and a decoder that skips it can hand an application silently-corrupted
bytes if a fragment was damaged in a way that didn't change its length.

**Fix:** the prototype's `splitDecode` recomputes the hash over the
reassembled bytes and rejects a mismatch; the spec should mandate this
rather than leave it as an implementer nicety.

### 6. Encrypt names a cipher but never a key source

§4.1's Type 4 example says "e.g. AES-GCM" and shows `nonce` +
`ciphertext+tag` fields, but nothing in the draft says where the key comes
from — passphrase KDF, pre-shared secret, recipient public key wrap,
something else. For §8's PGP-backup example specifically this is not a
minor omission: "Encrypt wrapper" is meaningless as an interoperable
mechanism without it, since two independent apps using Type 4 need to agree
not just on AES-GCM but on how the key got there. The prototype sidesteps
this entirely (tests pass a raw 32-byte key directly) — which is precisely
how prose review missed that the spec never actually answers it.

**Update:** resolved — spec §4.1 adds an optional Algorithm field (key `5`)
and Key Algorithm field (key `7`) to Type 4, both a COSE Algorithm ID
(RFC 9053/9054) or a plain string. Borrows an existing, actively
maintained IANA registry rather than inventing a QDEF-specific one — the
same pattern §4.3's Media Type uses, and for the same reason: a cipher
and a key-agreement scheme both already have a stable identity independent
of QDEF. See DESIGN.md's "Encrypt key provisioning" entry for the full
reasoning, including why this doesn't need Type Hint's decentralized-ID
layer either.

### 7. Nesting order is *not* decoder-detectable — confirmed, not just assumed

The spec (now DESIGN.md) already asked whether `Split → Encrypt → Compress`
is "just documented convention" or something a decoder could reject if
violated, and leaned ("not resolved") toward trusting the encoder. The prototype turned this
from a guess into a demonstrated fact: `prototype/src/wrappers.js`'s
`resolveStack` is a generic, type-directed resolver (unwrap whatever
wrapper Type ID is next, recurse, stop at the first non-wrapper Record) —
built once, with zero knowledge of "correct" order. It was run against both
the documented order (Split outermost) and a deliberately reversed one
(Encrypt applied per-fragment, Split innermost) — both decode to the
identical terminal Record with no error, no signal, nothing to distinguish
them (`prototype/test/nesting-order.test.js`).

This also means §4.1's stated rationale for the fixed order overstates its
case. It says "Split must be outermost — decompression/decryption need the
complete byte string, which only exists after reassembly," phrased as a
structural necessity. It isn't one: encrypting each fragment individually
(reversed order) is well-defined and round-trips fine, just at the cost of
a separate nonce/auth-tag per fragment instead of one for the whole
payload. The real reason to prefer Split-outermost is efficiency and
simplicity (one encrypt/compress operation instead of N), not correctness.

**Fix:** DESIGN.md's open question is now answered, not open — "trust the
encoder" is confirmed correct, but for a different reason than stated:
non-conformant order isn't just *undetected*, it's *unenforceable* by any
decoder built the natural (generic, recursive) way, and there is no
efficient way to make it enforceable without wrapper types carrying
redundant "what should be outside me" metadata that the format doesn't
otherwise need. §4.1's rationale text should be corrected to say
"recommended for efficiency," not "required for correctness."

## Findings from the Rust core-parser prototype

The Node prototype above validated the *design* — but it validated it using
Node's `cbor` npm package, which does all the real CBOR work (tags, maps,
streaming) for it. That left one of the spec's own claims (§3.3: a "deeply
constrained embedded scanner with no semantic-tag-aware CBOR library" can
implement the mandatory core) completely unverified — Node can't tell you
whether that's true. [`rust/qdef-core`](../rust/qdef-core) is a second,
independent implementation of the mandatory core only (not the standard record type
Wrapper layer), written `#![no_std]`, with zero dependencies and zero heap
allocation — including hand-rolling the CBOR primitives instead of using a
crate for them, since using one would just re-test the Node prototype's
finding a second time.

### 8. The "minimal core" claim is true, and now has a number attached

Built in release mode for `thumbv6m-none-eabi` (Cortex-M0 — one of the most
constrained ARM targets in common use, no atomics beyond the basics), the
entire mandatory core — magic framing, full CBOR-Sequence walking,
prefix-typeID routing, Hardware Parity mismatch detection, plus the even/odd
criticality helper and a field-lookup helper — compiles to **~3.7 KB of
code** (see #9 below for why that number moved), with **zero `unsafe`** and
**zero heap allocation**. §3.3's claim that a minimal implementer's surface
area is genuinely small was previously just prose confidence; it's now a
measured, reproducible number tied to a real embedded target.

### 9. Unbounded recursion depth wasn't just bounded — it was designed away entirely

First pass: skipping past a Record field (or an entire Record) the parser
doesn't recognize requires generically walking arbitrarily-nested CBOR
structures — arrays inside maps inside tags, etc. Written the natural way
(recursively), this has no inherent bound on stack depth: a malformed or
adversarial input with deeply nested structures could exhaust the stack on
a small MCU with a few KB of RAM. This is invisible when a hosted CBOR
library does the walking for you inside a process with megabytes of stack
and its own (possibly absent) guard — which is exactly why it never came up
in the Node prototype. The first fix was a `MAX_DEPTH` guard in
`rust/qdef-core/src/cbor.rs` (`skip_value` erroring past a fixed recursion
limit) — bounded, but still recursive.

A follow-up design review (prompted by comparing QDEF's problem to how
Protobuf's wire format handles the identical concern) asked a sharper
question: where does the recursion actually come from? Not from every CBOR
type — unsigned/negative integers, simple values, floats, and
definite-length byte/text strings are all skippable in O(1), because their
length is stated directly in their own head bytes. The recursion is
entirely confined to bare arrays, nested maps, and tags as a field's
*value* — types whose length isn't knowable without walking their contents.

**Fix:** rather than bound that recursion, remove the case that causes it.
§3.2 now includes a field-value-shape rule: a Record field's value (for any
key, recognized or not) MUST be a scalar or a definite-length string —
never a bare array, map, or tag. Structured content must be CBOR-encoded
separately and carried as a byte string's payload instead (the same
opaque-until-unwrapped pattern §4.1's Wrapper Records already use, applied
one level down, at individual fields instead of only whole Records). This
is the same trick Protobuf's wire format uses for exactly the same reason —
every field is varint/fixed-width/length-delimited, so skipping an unknown
one is always cheap — not a novel or risky pattern.

Checked against every existing worked example before adopting it: Wi-Fi
(100), Ticket (105), and all three Wrapper Records (Split/Compress/Encrypt)
already only ever use scalar or byte/text-string field values. Zero
retrofit cost. `rust/qdef-core/src/cbor.rs`'s `skip_value` was rewritten
from a recursive walker with a depth guard to pure non-recursive,
non-looping arithmetic — `MAX_DEPTH` and the whole recursive
skip_string/skip_items/skip_until_break machinery were deleted outright,
not just tuned. That shrank `skip_value` itself from 836 bytes to 284 bytes
(release, Cortex-M0) and the crate as a whole from ~4.4 KB to ~3.7 KB (#8).
Tests confirm both directions: a bare array as a field value is rejected
outright even under an otherwise-ignorable odd/optional key
(`field_value_shape_rule_rejects_a_bare_array_even_under_an_odd_optional_key`),
and the sanctioned byte-string-wrapped alternative round-trips its opaque
nested CBOR payload byte-for-byte
(`structured_content_is_carried_as_an_opaque_byte_string_and_skips_at_zero_cost`).

The broader lesson: the first fix (bound the recursion) treated the symptom
and would have shipped as "good enough." Asking *why* the recursion existed
at all — rather than just how deep it could safely go — found a fix that's
smaller, simpler to reason about, and cheaper to run, not merely safer.

### 10. A malformed (not just unrecognized) Record can desync the whole Sequence — the spec's "isolated failure" promise has an unstated precondition

§3.2 promises an aborted Record doesn't affect its siblings in the same
Sequence. That promise silently assumes the Record is at least *well-formed*
CBOR — its byte length needs to be determinable to know where the next
Record starts. A genuinely malformed byte stream (truncated, an invalid
length prefix, a reserved additional-info value) means the parser can no
longer find that boundary, so it can't safely resume the Sequence at all —
a fundamentally different, worse failure than "this Record's Type/keys
aren't recognized." The same is now also true of a Record that violates
finding #9's field-value-shape rule (a bare array/map/tag as a field
value): by construction, its length can't be determined without doing the
recursive walk the rule exists to avoid, so it's classified the same way —
Sequence-fatal, not Record-isolated. This distinction was invisible in the
Node prototype, where `cbor.decodeAllSync` either decodes the whole
sequence or throws for all of it — there was never a point where "resume
after this specific byte-level failure" was an explicit decision to make.
Writing the Rust `Records` iterator by hand forced the decision: it now
distinguishes "Record aborted but Sequence continues" (missing prefix
typeIDs — see findings #1–#2) from "Sequence itself is unrecoverable"
(malformed CBOR, or a field-value-shape violation), and only the former
lets iteration continue.

**Fix:** §3.2 should state this precondition explicitly rather than leave
it implicit — an aborted-but-well-formed Record doesn't affect siblings;
malformed CBOR at the Sequence level is a stronger failure with no
per-Record isolation possible.

## Findings from a spec review pass

### 11. The Smart Route's tag numbers collide with the IANA CBOR tag registry — Hardware Parity's key-0 route does not, verified both ways

A fresh review pass questioned whether "wrap the Record in a CBOR tag equal
to the Type ID" (§3.1's Smart Route) is actually safe, given CBOR tag
numbers are a shared IANA registry (RFC 8949 §9.2), not QDEF's own
namespace. Checked against a real decoder rather than left as a plausible
worry:

```
Tagged(2, <byte string>)  ->  decodes to a BigInt   (tag 2 = unsigned bignum)
Tagged(0, "2026-...")     ->  decodes to a Date      (tag 0 = date/time string)
Tagged(0, <a Record map>) ->  decodes to Invalid Date
```

Types 2/3/4/5 (the entire Wrapper standard record types) and Type 100 (the flagship Wi-Fi
example) all reuse tag numbers IANA has already assigned real, live meaning
to. QDEF's own worked examples aren't hypothetically at risk — they're
already using colliding numbers today. A permissive decoder happens to fall
back to passthrough when the tagged content doesn't match the registered
type's expected shape (a byte string for a bignum, a text string for a
date) — but a stricter conformant decoder, precisely the tag-aware audience
the Smart Route exists to serve, is entitled to reject or mangle it, and
wrapping an actual Record map in tag 0 demonstrably does mangle it.

The follow-up question — does Hardware Parity's *other* route, key `0`,
have the same problem? — was worth checking rather than assuming, since
"QDEF picked a number that collides with something" was already true once.
It does not, and the reason is structural, not luck: CBOR's IANA
Considerations register tag numbers and simple values — there is no
registry for map keys, because a bare CBOR map carries no built-in semantic
layer the way a tag does. A generic decoder has nothing to coerce key `0`
into; it's just data until something that knows the surrounding schema (a
QDEF-aware parser) gives it meaning. Verified: encoding the identical
Record map with *no* tag at all round-trips through a generic decoder as
inert data (`map.get(0) === 100`, no coercion), while the same map wrapped
in tag `0` decodes to `Invalid Date`. The asymmetry is exactly the
asymmetry the format's own layering predicts — key `0` is the mandatory
Constrained Route for a reason, and this is a second, independent reason
beyond §1's "not every CBOR library exposes tags."

**Fix:** at the time this was written, left open pending a decision between
three wire-format resolutions. Superseded — see finding #12: the tag route
was removed outright, for a reason beyond the collision this finding
verified.

### 12. The tag route wasn't just collision-prone — it was the wrong mechanism, and removing it simplified the core

Finding #11 verified a real, reproduced IANA tag-number collision and
confirmed key `0` was unaffected. That was enough to justify *a* fix, but
not enough on its own to justify which fix — a wider or offset tag range
would have dodged the specific collision without addressing why it
happened. A follow-up review pass asked what a CBOR tag number is actually
*for*: RFC 8949 §3.4's model is one tag number carrying one predefined,
universal interpretation of a data item (a byte string *is* a bignum, a
text string *is* a date) that any implementation can look up and apply —
not a private space handed out in bulk for one application's internal
dispatch table. Under that model, "tag == Type ID" was never a sound
mechanism, independent of which specific numbers happened to be free at
any given moment; "offset into unassigned tag space" (one of finding #11's
three candidate fixes) would have preserved the exact category error on
numbers that merely hadn't collided *yet*.

**Fix:** the tag route (the "Smart Route") is removed outright. Prefix
typeIDs are now the sole Record Type ID routing mechanism — §3.1 no longer
describes two routes, only one. This is a genuine simplification of the
mandatory core, not just a safer version of the old design: `rust/qdef-core`'s
`parse_record` no longer needs to branch on CBOR major type 6 to detect an
optional tag, the `Record` struct no longer carries a `tag` field, and
`AbortReason::HardwareParityMismatch` (finding #1's fix) is dead code once
there's nothing left to mismatch against. The one place a CBOR tag still
legitimately appears in QDEF — §3.2's optional tag-24 hint on an
individual field's byte-string *value* — was never affected by any of
this: it's a Record-Type author's own opt-in annotation about one field's
content, exactly the "predefined, universal meaning" use tags are
correctly for, not a mechanism QDEF's core routing depends on.

### 13. A Wrapper Record's Type ID is itself a public declaration — fine for Split/Compress, a real problem for Encrypt when deniability matters

Checked against a real adopter's threat model, not surfaced by prototyping
or prose review: `mofosyne/tagdrop`'s own encryption (SPEC.md §9) uses
AES-256-GCM — an exact match for COSE's `A256GCM` (= 3), confirming §4.1's
Encrypt Algorithm field picked the right registry and the right value for
at least one real cipher choice. But TagDrop's `encryption` field is
explicitly documented as "an optional hint, not a precondition": the real
mechanism is trial decryption against known keys, confirmed only by
AES-GCM's own auth-tag success ("discovery, not declaration"), because
SPEC.md's stated goal is that ciphertext stays indistinguishable from
random. A QDEF Encrypt Wrapper can't preserve that property regardless of
how its fields are shaped: being wrapped in a Type-`4` Record at all is
itself a visible declaration — "this is encrypted" — to any QDEF-aware
parser walking the Sequence, even one that can't decode the payload,
because Type ID routing (§3.1) is unconditional and happens before any
per-Record-Type logic runs. Every Wrapper Record makes this same kind of
declaration (Split says "this is one fragment of something," Compress
says "this is compressed") — it's simply invisible as a cost for those,
since neither Split nor Compress has a reason to want to look like
un-fragmented, uncompressed data. Encrypt is the one Wrapper where an
adopter might specifically need the opposite: to not be identifiable as
encrypted at all.

**Not a bug to fix — a genuine, principled scope boundary**, the same
category as §1's "when QDEF earns its place": an application whose threat
model requires ciphertext indistinguishable from random has a requirement
QDEF's routing model is structurally unable to satisfy, since self-
describing dispatch is the format's entire reason for existing. TagDrop's
own §6 registration already sidesteps this correctly — its encryption
happens entirely inside the opaque registered blob, never at the QDEF
layer — which is exactly the right call, not a workaround. Also confirmed
directly against the IANA COSE Algorithms registry: PBKDF2 (TagDrop's
passphrase-based key-provisioning mode) has no COSE algorithm ID at all —
COSE's key-derivation entries are all HKDF variants — so even an adopter
without TagDrop's deniability requirement would hit Key Algorithm's
plain-string fallback for this specific case, not the numeric one.

### 14. The Node prototype's own dependency mis-encodes large Type IDs — caught only because a real adopter used the private-use tier as recommended

TagDrop is the first adopter actually using §9's `0x10000`+ private-use
tier as intended — a real ~64-bit random Type ID, not an illustrative
placeholder like every worked example in this repo (`100`, `105`, `2`–`5`,
`900`, `950`) has ever been. Checking that against this repo's own
prototype, not TagDrop's, surfaced a real bug: reproduced directly against
the `cbor` npm package used throughout `prototype/src/`, `cbor.encode()`
wraps *every* BigInt-typed input in CBOR tag 2 (bignum) — regardless of
magnitude, confirmed from `100n` (which trivially fits as a one-byte
native uint) up through `2n**64n - 1n`. Not a magnitude threshold, purely
"BigInt in, tag 2 out."

Why this would matter: any Type ID wide enough to need a JS BigInt (which
is exactly what §9 recommends for this tier, and exactly what routes
through `typeIds: [typeId]` in the record prefix) would violate §3.1's
requirement that prefix typeIDs be plain uints — for the one field the
entire minimal-core-parser design depends on being trivially readable. It's the
same underlying hazard findings #11/#12 already found and thought was
closed by removing the old Smart-Route tag-wrapping mechanism, resurfacing
through a completely different path: not QDEF's own wire-format design
this time, but a widely-used library's default behavior for a JS type
(`BigInt`) none of this repo's own worked examples ever needed, since
every one of them fits comfortably in a plain `Number`.

**Not currently live, but only by accident, not by design.** Checked
directly: `core.encodeRecordBytes` uses `cbor.encodeCanonical`, not plain
`cbor.encode` — a change made for an unrelated reason (§3.4's canonical-
encoding requirement) — and `encodeCanonical` does not exhibit this bug at
any magnitude tested. So the exact scenario reported (a real BigInt-class
Type ID) currently encodes correctly, verified against the live code, not
assumed. That's a fortunate side effect of the canonical-encoding switch,
not something anyone verified or tested for at the time it happened —
before that change (i.e. for this repo's entire history prior to this
session's canonical-encoding work), this bug would have been live for any
adopter following §9's own advice.

**Fix:** added a regression test suite
(`prototype/test/large-type-id.test.js`) that locks this in rather than
leaving it as an unverified side effect — including a test that documents
the dependency bug directly, so a future change back toward plain
`cbor.encode()` (for any reason) would be caught immediately rather than
rediscovered the same way this was. Also added a cross-implementation
fixture (`LARGE_TYPE_ID_CONTAINER`, Type ID = `u64::MAX`) proving the Rust
decoder reads a real large Type ID correctly too, not just assumed to
handle the full `u64` range from its `type_id: Option<u64>` field type.

**Worth generalizing as implementer guidance, not just a fixed bug:** any
QDEF implementation in a language with a similar split between "small
integer" and "big integer" CBOR encoding paths should verify its specific
encoder — not just its CBOR library's existence — actually produces a
native uint for a Type ID wide enough to need the bigger path, especially
for §9's private-use tier where that's the expected, recommended case,
not an edge case. This repo's own reference prototype had exactly this
gap for its entire history until now, never caught by any of its own
worked examples, only surfaced by a real adopter following the spec's own
advice literally.

### 15. §3.2's field-value-shape rule was more restrictive than it needed to be — tag 24 is skip-safe too, if bounded correctly

Filed as [GitHub issue #8](https://github.com/mofosyne/qdef/issues/8): the
original rule banned *every* CBOR tag as a field value, including tag `24`
("encoded CBOR data item," RFC 8949 §3.4.5.1), even though a tag wrapping
a definite-length string directly is exactly as skip-safe as a bare
string — its length is still just "read the string's own head," one fixed
step later than usual, never a walk. The existing "opaque byte string,
optionally tag-24'd *inside* its own re-decoded contents" pattern already
let an author signal "this is re-parseable CBOR" to something that opts
in, but never to a generic CBOR tool walking the container from the
outside — from there, a QDEF field's byte string looked identical whether
it held raw opaque bytes or further CBOR, unless that tool already had
out-of-band schema knowledge of the specific Record Type.

**The rule change needed one careful bound, not just a blanket
relaxation.** "Allow tags that are skip-safe" is true but dangerous if
stated loosely: if "skip-safe" is defined recursively (a tag wrapping
anything itself skip-safe, including another tag), adversarial input can
nest tag `24` inside tag `24` inside tag `24` arbitrarily deep — reopening
exactly the unbounded-recursion hazard the field-value-shape rule exists
to close (finding #9). The correct, narrower rule: tag `24` may wrap a
definite-length string *directly*, checked by one extra fixed header read
inline, never by calling the skip function back into itself. Verified this
distinction is real, not theoretical, with a dedicated fixture
(`NESTED_TAG24_CONTAINER`) constructed so the outer tag's immediately-
following item is itself a tag — genuinely different from (and still
allowed) a byte string whose own *contents*, once independently decoded,
happen to be tag-24'd, since that's invisible to the outer skip either way.

**Also narrower than "any skip-safe tag" for a second, independent
reason:** allowing arbitrary tag numbers here — not just `24` — would
reopen the "private, per-application enumeration" hazard the old
CBOR-tag routing mechanism was removed for (findings #11-#12), just at
the field level instead of the whole-Record level. Tag `24` specifically
is the one exception with a real, IANA-standardized, non-QDEF-specific
meaning; a fixture using tag `0` ("standard date/time string," also a
real registered tag) wrapping a byte string confirms it's still rejected.

**Fix:** `rust/qdef-core/src/cbor.rs`'s `skip_value` gained one new match
arm — tag `24` wrapping a definite-length string, verified inline rather
than recursively — keeping the "conformant core parser never needs to
recurse at all" property intact rather than merely bounding recursion
depth. Spec §3.2 rewritten accordingly. Three new cross-implementation
fixtures prove all three cases: the allowed shape round-trips, tag-in-tag
nesting is rejected, and a non-`24` tag is rejected. `clippy`, `fmt`, and
the `thumbv6m-none-eabi` embedded build all still pass.

**Update:** the "only tag `24`, no other tag" restriction described above
was itself narrower than it needed to be — widened in finding #16 below
after actually surveying what the rest of the tag registry looks like,
rather than assuming a wider rule was automatically unsafe.

### 16. The "only tag 24" restriction was itself overly cautious — surveyed the registry instead of assuming

Asked directly, rather than left as an assumption: does the rest of the
IANA CBOR tag registry (tags under ~1000) actually need excluding, or was
restricting finding #15's fix to tag `24` alone stricter than the real
safety property required? Checked the registry directly, not from memory.
It splits cleanly by each tag's own RFC 8949 definition — genuinely
scalar/string-shaped (dates, URIs, UUIDs, regex, bignums, base64/base16
conversion hints, typed numeric arrays wire-encoded as byte strings)
versus genuinely array/map-shaped by definition (decimal fractions and
bigfloats — a 2-element array; rational numbers; language-tagged strings,
`[language, text]`, easy to mistake for a bare string; COSE structures;
the "expected conversion" hints `21`–`23`, confirmed directly against RFC
8949 §3.4.5.2 to apply recursively over arbitrary structure, not just a
byte string, on request rather than assumed).

The content-shape check already built for tag `24` — content must be a
definite-length string *directly*, never another tag — turns out to be
exactly the right and sufficient bound regardless of *which* tag number is
on the wire, so restricting to a single number was doing no additional
safety work, just narrower than necessary. Verified this holds correctly
in both directions with new fixtures: `OTHER_TAG_WRAPPED_VALUE_CONTAINER`
(tag `0`, a real IANA tag, wrapping a definite-length text string) is now
correctly accepted; `STRUCTURED_TAG_WRAPPED_VALUE_CONTAINER` (tag `4`,
"decimal fraction," wrapping a real, plausible `[-2, 27315]` — meaning
273.15, not a contrived value) is still correctly rejected, proving the
bound tracks content shape, not tag number.

**Fix:** `skip_value`'s tag branch widened from `6 if head.arg == 24` to
plain `6` (any tag major type), with the same inline, non-recursive
content check as before. Spec §3.2 and DESIGN.md's rationale both
rewritten to describe the general rule rather than the tag-`24`-specific
case. `clippy`, `fmt`, and the `thumbv6m-none-eabi` embedded build all
still pass; 15 Rust tests (2 new) and 35 Node tests all green.

### 17. App Route (Type 7) — the AAR-equivalent deferred earlier in this project, built once a real adopter actually needed it

Building TagDrop's Paper port on QDEF surfaced three related questions
about the private-use Type ID tier, filed as [GitHub issue
#10](https://github.com/mofosyne/qdef/issues/10). One of them — should a
generic scanner be able to route a scanned code to a specific handling
application, the way NFC's Android Application Record does — had already
come up once earlier in this project's history and was deliberately left
unbuilt: "figure out later... as long as our QDEF system is flexible to
assign a Type ID to it later." This is that later.

Landed as spec §4.4, a plain standard record type (Type `7`, not a wrapper):

- **Domain-verified, not a bare string claim.** A package name or
  reverse-domain string can't prove anything — any app can claim to be
  `com.example.official`. A domain, verified the way Android App Links
  and iOS Universal Links already require (a `.well-known` file on a
  domain the claimant controls), inherits proven, already-deployed
  platform trust machinery instead of QDEF inventing a new one — the
  same "borrow, don't invent" instinct behind the COSE and CoAP registry
  choices elsewhere in this document.
- **Decoupled from payload-shape Type IDs, not folded into them.**
  TagDrop's own first draft of this idea (structuring a private-use Type
  ID as an app-id prefix plus a self-allocated subtype) was reconsidered
  and set aside in favor of this decoupled sibling-Record approach — it
  keeps an open, shared payload shape interoperable across independent
  handling applications, and needs no adopter to restructure their
  existing Type IDs to get auto-launch support. The structured-Type-ID
  idea wasn't wasted, though: kept as general private-use tier guidance
  (DESIGN.md's "Registry governance" entry) for implementers who want to
  reduce CSPRNG draws across their own several Record Types, independent
  of routing.
- **Dispatch stays local and OS-level**, matched only against what's
  actually installed on-device — no QDEF-level or central registry
  needed for routing to function at all, the same reasoning that already
  keeps registry governance (still open, above) from blocking anyone
  using the private-use tier today.

Prototyped in `prototype/test/app-route.test.js`: round-trips with and
without the optional label, isn't positionally special (routes
identically whether first or last in the Sequence), skips cleanly for an
application with no interest in it, and — since §4.4 recommends
repeating it verbatim across every code in a multi-code group — proves
two independent encodes of the same fields produce byte-identical
output, exercising §3.4's canonical-encoding guarantee rather than
assuming it holds for a new Record Type too.

**Update:** the original spec text described OS-level dispatch as
working "the same way Android already resolves AAR/Intent-filter
matches" — asked directly whether that actually holds for iOS too, not
just Android, and it doesn't uniformly. Checked directly against Apple's
own Universal Links documentation: iOS has the same domain-verification
*trust model* (`apple-app-site-association`, functionally equivalent to
Android's `assetlinks.json`), but no equivalent *query* API — Android
exposes an explicit "which installed app claims this" lookup, while iOS
dispatch happens as a side effect of a scanner constructing and opening
an actual `https://` URL from the domain, with no separate lookup step
available. End-user outcome is the same either way; the mechanism a
scanner implementation needs is not. Spec §4.4 corrected to describe both
paths explicitly rather than implying one uniform cross-platform API.

**Second update:** A scenario raised during design discussion surfaced a
use for key `0` the domain form can't serve well — a fast, per-code
check that a scanned code plausibly belongs to the group being
reassembled, run *before* attempting reassembly, independent of which
code(s) in the group happen to carry a full domain-form Record. Chasing
whether CBOR reference tags could cut
cross-code repetition (see DESIGN.md's reference-tags entry) confirmed
those can't reach across physically separate codes at all — no shared
decode state exists between them — which ruled that out as a fix for
this but clarified the actual shape of what would work: something
cheap, present on every code, checkable with no shared state. §4.4 now
documents App Route's key `0` as two forms: the domain string (auto-
launch dispatch, real authorization) and a private-use-random uint
reusing Type Hint's exact name-binding pattern (§3.1) for this pre-
filter role — no anti-spoofing property, explicitly not a substitute for
`group_id` (§4.1), which remains the actual integrity check. Prototyped
in `prototype/test/app-route.test.js`: the uint form round-trips, and a
decoder that only checks Type ID `7` presence skips it cleanly without
needing to know key `0`'s shape in advance.

**Third update:** briefly added, then removed, a Companion ID field
(key `3`) letting the domain form vouch for the decentralized form's
per-code pre-filter with real, App-Links-verified trust instead of just
hash-derivation self-consistency — TagDrop independently confirmed its
session-scoping bound was correctly shaped for their own (session-
discontinuous) use case, not a gap. Removed once §3.5's format-namespace
mechanism (Record Type `0`) landed and turned out to do the same
per-code pre-filter job better: structurally guaranteed first (Companion
ID lived on App Route, explicitly *not* positionally special) and
genuinely zero-cost when unused (Companion ID needed a full decentralized-
form App Route record on every sibling code). Two mechanisms answering
the same question from different Record Types would have been exactly
the duplication this project avoids elsewhere — see FINDINGS #19 and
DESIGN.md's "container header collapsed" entry for the full reasoning.
Nothing had shipped, so this was a clean removal: §4.4 is back to its
pre-Companion-ID shape, including the domain form's key `1` reverting to
a plain label (the unification with the decentralized form's Hint-name
role existed only to make Companion ID hash-checkable).

**Fourth update:** TagDrop checked the decentralized form's 41-byte
figure independently (prefix typeIDs + map head + `{0:<uint64>}` + `{1:"..."}`,
byte for byte) and it matched, but flagged something the spec text
hadn't said explicitly: mandatory per-code repetition means "cheap"
describes one code's cost, not a multi-code group's total — a 7-code
group pays 7×41 = 287 bytes for App Route alone. Verified directly
against the actual encoder (`core.encodeRecordBytes`) rather than
re-deriving the arithmetic by hand: 41 bytes with a Hint name, 13
without, confirming both the flagged number and the cheaper
no-Hint-name variant. §4.4 still says this explicitly, independent of
the Companion ID removal above.

### 18. "Private-use" was being misread as "closed/internal" — the tier description was wrong, not just imprecise

While drafting a reply to TagDrop about App Route's decentralized form,
the spec text (DESIGN.md's "Registry governance" and both Scope notes
this fed) described the `0x10000`+ private-use-random Type ID tier as
"the correct answer for closed/internal Record Types that will never be
published or need to interoperate with an unrelated implementer."
Challenged directly: that's not what "decentralized" means. Distributing
who's allowed to *mint* an ID (no registry gatekeeping) is a different
axis from restricting who's allowed to *see or use* it — and the spec's
own mechanisms already contradicted the description. Type Hint's whole
purpose (§3.1) is letting an unrelated implementer recognize a
self-allocated ID; App Route's decentralized form (finding #17's
"Second update," above) is a second, freshly-built mechanism doing
exactly that. The tier's own description was the outlier, not those
mechanisms.

The parallel offered — Bluetooth's private/random device addresses,
self-assigned without any central authority but never meant to imply
"nobody else will ever see or connect to this device" — is the same
distinction Unicode's Private Use Areas already demonstrate (self-
allocated codepoints that shipped in real, shared icon fonts and
pre-standardization emoji long before any registry blessed them). Same
shape of correction as findings #15/#16: the restriction was written for
a narrower case than the one actually being served, caught by an outside
challenge to specific wording rather than an accident of implementation.

Corrected in DESIGN.md's "Registry governance" tier description and both
Scope notes (DESIGN.md's private-use-tier one and spec §4.4's App Route
one) — the tier is now described as decentralized-by-authority, not
scoped-by-visibility, and the "genuine widening" framing both Scope notes
built on top of the wrong premise is removed rather than patched, since
there was no widening to warn about once the premise is fixed. Nothing
about the wire format, the Node prototype, or any Rust code needed to
change — this was a documentation-only error, never a shipped behavior.

### 19. The container header collapsed to magic + a CBOR Sequence — no version byte, no separate header structure

What began as a request for an optional format-namespace field on the
header (RIFF's `WAVE` form-type was the explicit reference point) ended
as a wire-format simplification: the container is now `QDEF` (4 bytes)
plus a CBOR Sequence of Records, nothing else. The version byte is gone.
Container-level metadata (a format namespace, an optional recoverable
name for it) lives inside the Sequence as Record Type `0` — an ordinary
Record, not a second wire structure, decoded by the exact same prefix-typeID/
even-odd machinery as everything else (spec §3.5).

Landed after several rounds that each corrected a real, specific
overreach rather than converging in one pass — three worth naming since
each would have shipped a genuine inconsistency otherwise: a fixed-width
header field taxing every container regardless of use, "different Type
ID = different header version" wasting Type ID space and breaking with
how every other standard record type actually evolves, and a near-miss reusing
key `1` for a version field despite it already being globally reserved
as Type Hint. See DESIGN.md's "The container header collapsed" entry for
the full reasoning on each.

**Concretely, what changed:**

- `prototype/src/core.js`: `encodeContainer`/`decodeContainer` no longer
  read or write a version byte. `core.VERSION` no longer exists.
- `prototype/src/header.js` (new): Type `0`, namespace at key `3`, Hint
  name at key `5`, both odd/optional, positional-first requirement
  enforced by `extractHeader()` with a graceful (never hard-failing)
  degrade to unnamespaced otherwise.
- `rust/qdef-core`: `VERSION` constant, the `version` field on
  `Container`, and the `UnsupportedVersion` error variant all removed.
  No Type-0-specific code added — proven, not just asserted, by
  `record_type_0_needs_no_special_handling_from_this_crate` decoding a
  Type `0` + Wi-Fi container through the unmodified generic path.
- `prototype/scripts/gen-rust-fixtures.js` had six stray references to
  the now-removed `core.VERSION` that would have silently produced
  `Buffer.from([undefined])` garbage bytes into the committed fixtures —
  caught by CI's fixtures-in-sync check failing on push, not by manual
  inspection. Regenerated correctly, plus a new cross-implementation
  fixture (`HEADER_CONTAINER`) for the Type `0` case.

Verified: Node 55/55, Rust 16/16, `clippy` clean, `fmt` clean,
`thumbv6m-none-eabi` release build succeeds, PR #12 CI green on both
jobs across two pushes (the second push fixing exactly the fixture-sync
failure the first one caused).

### 20. Namespace-scoped Type IDs resolved — TagDrop's concrete want, not a hypothetical one, is what unblocked it

§3.5 shipped with the `100`+ scoping question deliberately open. Asked
directly by TagDrop, with a concrete want (shrinking four existing
64-bit Type IDs, not a hypothetical future need) once they saw the
namespace mechanism's detection win was cheaper than expected — the
same "wait for a real adopter" discipline that shaped App Route.

Resolved as a compound-key lookup, `(namespace, TypeID)` rather than
`TypeID` alone, once a namespace is declared — reusing the existing flat
numbering space rather than reserving a new sub-range for it, since a
compound key removes the collision ambiguity structurally (see
DESIGN.md's full entry for why the reserved-range alternative doesn't
actually need solving once that's noticed).

Named the one real sharp edge rather than leaving it implicit: a
decoder implementing specific namespace-scopable Type ID semantics that
doesn't check for a namespace first can misapply a global interpretation
to a namespace-scoped Record sharing the same number — a wrong match,
not a clean miss. Framed as Record-Type-interpretation-specific handling
(same category as Type Hint's dual-mode key `1`), so the mandatory core
stays exactly as minimal as already validated — no changes to `core.js`
or `rust/qdef-core` were needed or made.

**Follow-up, same day:** asked directly whether the always-global floor
(originally `100`) actually protected the right range. It didn't fully
— a decoder hardcoding against the *reviewed, well-known*
common-vocabulary tier (`100`–`999`) has no reason to ever read §3.5,
meaning it wasn't accepting the sharp edge, it just never knew the edge
existed. Extended the floor to `1000`: `1`–`999` (standard record types *and*
common-vocabulary) now stays unconditionally global; only the
less-curated first-come tier (`1000`+) is actually namespace-scopable.
Cost verified, not assumed: cheapest namespace-scoped Type ID moved from
4 bytes to 5. A stricter 32-bit-class floor (`≥0x10000`, closing the
first-come tier's edge too) was considered and set aside at 7 bytes
minimum — real, but paying for safety margin against a risk already
judged lower-stakes than the one actually being closed.

**Second follow-up, same day: is `1000` a principled number, or just a
round one?** The latter — corrected once pointed at IANA's own CBOR tag
registry, which draws the identical three-way split verbatim: `0`–`23`
Standards Action, `24`–`32767` Specification Required, `32768`+ First
Come First Served (checked directly against
[iana.org/assignments/cbor-tags](https://www.iana.org/assignments/cbor-tags/cbor-tags.xhtml),
not from memory). Checked the real cost before moving, the same
discipline as every other boundary decision here: `1000` and `32768`
both fall inside CBOR's `256`–`65535` uint class, so both cost 5 bytes
minimum — moving the floor to `32768` was a free upgrade (more
common-vocabulary headroom, an externally-citable boundary), not a
tradeoff. `1`–`99` (standard record types) was deliberately left un-aligned with
IANA's `0`–`23` — that tier answers a different question (what a
generic tool must unwrap regardless of namespace) than IANA's Standards
Action band (who can change the CBOR spec itself), and renumbering
seven already-shipped mechanism IDs would have bought nothing.

**Third follow-up, same day: does the first-come tier still earn its
place, now that namespace-scoping exists?** Asked directly, once it was
noticed that first-come is exactly the range namespace-scoping applies
to, and is a no-op the moment no namespace is declared. No — dropped
it. Collision-avoidance for a Type ID only ever comes from one of
three sources: registry curation, the ID's own numeric width, or a
declared namespace. First-come tried to be cheap *and* uncoordinated
without picking any of the three, which is exactly why it never had a
real governance model (this project's own earlier "no registry
authority exists yet" admission, and its own §6 worked example already
steered real adopters toward private-use-random instead, in practice).
Declaring a namespace and using small sequential IDs inside it already
covers the first-come tier's entire use case, with a mechanism that has
a real governance story. Needed no code change: `resolveLookupKey`'s
floor check never implemented "first-come" as a distinct mechanism, so
this was purely a governance/vocabulary simplification, not a wire
change.

**Fourth follow-up, same day: is a namespace-local Type ID a truncated
wide ID, or a freshly chosen one?** Asked directly because "shrinking
four existing 64-bit Type IDs" reads ambiguously either way. It's the
latter, and it matters which: `resolveLookupKey` only checks magnitude
against the ceiling, so it can't tell a freshly-picked small number
from the low bits of a truncated wide one — and a truncated value's
magnitude is effectively random with respect to the ceiling, meaning it
can land below it purely by chance. A Type ID below the ceiling is
*always* global regardless of any declared namespace, so a truncation-
derived ID would silently lose its own namespace scoping some fraction
of the time — the same wrong-match failure mode named earlier, this
time triggered at ID-selection time rather than decode time. Made
explicit in §3.5 rather than left inferrable from the "shrinking"
phrasing, and demonstrated, not just asserted: a new test constructs a
real 64-bit private-use-random ID truncated to its low 15 bits and
confirms it resolves globally, not namespace-scoped, despite a
namespace being declared.

Prototyped in `prototype/src/header.js`'s `resolveLookupKey` and
`prototype/test/header.test.js`: compound-key resolution differs by
namespace, `1`–`32767` stays global unconditionally (both standard record types and
the full IANA-aligned common-vocabulary range, tested explicitly), a
namespace-aware dispatcher correctly refuses to fall back to a
recognized global meaning for an unrecognized namespace-scoped pairing
above the ceiling (the sharp edge, demonstrated rather than described),
a naive decoder with zero namespace awareness still correctly resolves
a common-vocabulary Type ID (the specific failure mode the floor
extension exists to close), a truncated-ID pick landing below the
ceiling silently loses its namespace scoping (the ID-selection-time
version of the same sharp edge), and TagDrop's own migration case end
to end with real, verified byte counts: 11 bytes for a bare Record
under an existing 64-bit global Type ID, 5 bytes for the same under a
namespace-scoped small one at the current `32768` floor — unchanged
from the old `1000` floor, confirming the free-upgrade cost claim
against the actual encoder rather than just the size-class table.

### 21. The hash-derivation algorithm was never pinned — and the prototype had a live bug matching the gap exactly

Asked directly whether §3.1's `ID = truncate(hash(name), N)` had ever
actually been specified precisely enough for independent implementations
to agree. It hadn't: no hash function was named, no string encoding, no
truncation/byte-order rule, and `N` was explicitly called "an open
parameter." Checking the real prototype rather than trusting the prose
surfaced a live bug matching the gap: `verifyTypeHint` called
`deriveHashId` with no width argument, silently defaulting to a 4-byte
truncation regardless of the candidate ID's actual magnitude — meaning a
genuinely 64-bit-class ID (exactly what §9 recommends and what TagDrop's
own existing Type IDs actually are) could never verify, no matter how it
was derived. The "anyone can independently check" claim this whole
mechanism exists to deliver was false in practice for the one adopter
actually positioned to use it.

Fixed by making `N` derived from the candidate ID's own byte-width (4 if
it fits in 32 bits, 8 otherwise) instead of a free parameter, and pinning
the rest: SHA-256 over the name's raw UTF-8 bytes, first `N` digest bytes
as a big-endian uint. A second bug caught in the same pass: comparing a
narrow (Number) and wide (BigInt) derivation with `===` is unsafe --
`5 === 5n` is `false` in JS -- fixed by normalizing both sides through
`BigInt(...)` before comparing. Also implemented `header.js`'s
`verifyNamespaceHint` for the first time: §3.5 described the namespace
mechanism's own hash-check in prose since it landed, with nothing in the
prototype actually backing it. It calls `typeHint.js`'s derivation
directly rather than reimplementing the algorithm, so namespace values
and Type IDs are checked identically by construction.

Prototyped in `prototype/test/type-hint.test.js` (a regression test
proving a 64-bit-class ID now verifies where it silently couldn't
before, and a narrow-vs-wide cross-verification test) and
`prototype/test/header.test.js` (the namespace hash-check exercised for
the first time, mirroring Type Hint's own three-way verify/degrade/
not-applicable split). See DESIGN.md's matching entry for the full
reasoning behind each fix.

### 22. Pinning the hash algorithm didn't fix the naming problem — the input needs its own collision-resistance guidance

Asked directly, right after #21 landed: does the spec tell anyone how
to *choose* the name fed into hash-derivation, so two unrelated
implementations don't collide by accident? It didn't, anywhere — only
"e.g. a reverse-domain string" appeared once, as an illustrative
example, never as guidance.

This is a real gap, not a nice-to-have: `ID = truncate(SHA-256(name),
N)` is only as collision-resistant as `name` is diverse. Two unrelated
projects independently naming their config record `"config"` derive the
*identical* ID — a certain collision, not a probabilistic one, since
the function is deterministic and short, sensible English words for a
common concept are a small space heavily shared across unrelated
authors. Demonstrated directly with real hash output rather than argued
abstractly: `deriveHashId('config', 8)` computed twice, simulating two
independent projects, produces the same value both times.

Fixed by recommending the same convention every other namespaced-
identifier system already uses — reverse-domain qualification
(`"com.example.tagdrop"`, not bare `"tagdrop"`) — with the reasoning
spelled out for why it actually works (a domain two unrelated parties
could both plausibly register is already vanishingly unlikely by DNS's
own allocation guarantees, which is what restores the "behaves like a
random draw" property hash-derivation depends on) rather than presented
as unmotivated style guidance.

Scoped precisely, not applied blanket: only a namespace's own Hint name
(§3.5) and a standalone (non-namespaced) private-use-random Type ID's
Hint name actually need this — a Record-Type-local Hint name used
*inside* an already-declared namespace is already protected by the
namespace itself and doesn't need qualifying.

Prototyped in `prototype/test/type-hint.test.js`: two unrelated
"projects" naming the same concept `"config"` derive an identical ID
(the hazard, demonstrated), and the same two projects qualifying by a
domain they each control do not collide.

### 23. `resolveStack` had no defined behavior for a Type `0` header coexisting with a Wrapper Record — TagDrop's multi-code question exposed it before it shipped wrong

TagDrop asked directly whether a namespace declaration needs to repeat
on every physical code of a multi-code Split group before adopting
namespace-scoping for real. Tracing the actual mechanics to answer it
precisely (not by analogy to Preview/App Route alone) found a real gap:
`prototype/src/wrappers.js`'s `resolveStack` only ever inspected
`records[0]` of each code, with no path at all for a Type `0` sibling to
coexist with a Split/Compress/Encrypt Wrapper Record in the same code's
Sequence — and no defined rule for whether a namespace declared that way
even reaches a Record only discoverable after full Wrapper resolution.
Neither was a deliberate scope decision; the interaction had simply
never been asked about before.

**Fixed on both counts.** `resolveStack` now locates a Type `0` sibling
per code (routing from the *second* Record instead of the first when one
is present), requires every code that declares a namespace to agree, and
applies the agreed namespace to whatever Record the stack ultimately
resolves to — including one only reachable after full Split reassembly.
Throws via the same `resolveLookupKey` check §3.5 already defines for
the plain-sibling case if the terminal Record's Type ID is namespace-
scoped and no namespace was found anywhere in the group.

**The harder finding: repetition isn't just a cost question, it's a
robustness asymmetry that already-shipped machinery doesn't cover.**
`parity_scheme` recovers a missing *fragment's bytes*; a Type `0` Record
is a whole sibling Record, entirely outside the Split group's own
fragment data, so parity gives it no protection at all. Demonstrated
directly rather than argued: a namespace declared on exactly one code,
with that code then dropped, aborts the namespace-scoped Type ID even
though XOR parity fully recovers the Split-protected content from the
remaining codes. Requiring uniform per-code repetition — the same rule
Preview and App Route's decentralized form already follow — closes this
rather than leaving Split-protected content more fragile in namespace
terms than in content terms.

**Real, sometimes negative, wire cost — verified against the actual
encoder:** shrinking one namespace-scoped Type ID (10-byte decentralized
byte string → 4-byte small odd uint) saves 6 bytes; the cheapest legal
repeated Type `0` header costs 8 bytes/code. One shrunk ID alone is a net
+2 bytes/code regression; breakeven needs at least two namespace-scoped
Type IDs' worth of savings sharing the same code's header cost.

Prototyped in `prototype/test/multi-code-namespace.test.js`: the
repeated case resolving correctly through full Split reassembly, the
single-point-of-failure case reproduced directly (survives while its
code is present, aborts the instant that code is dropped, despite full
content recovery via parity), disagreeing codes across a group rejected
outright, and the no-namespace-anywhere case aborting the same way the
already-covered single-code case does.

### 24. Two stale examples used a magnitude that stopped mattering once the redesign removed the floor — and the cost comparisons using them undercounted the real savings

While working through finding #23's byte math further, checking whether
TagDrop's real remaining gap could shrink more: the `32769`-style "small
odd uint" examples used throughout §3.5 and DESIGN.md's namespace entry
were never actually the minimum. They're leftover from the pre-redesign
spec, where `32768` was a hard floor; the current parity-based rule has
no floor at all. A genuinely minimal odd uint (`1`, `3`, `5`...) costs
**2 bytes bare**, not 4 — CBOR packs `0`–`23` into the initial byte with
no argument bytes. Recomputed the breakeven with the real number:
per-ID saving against a 10-byte decentralized baseline is 8 bytes, not
6, meaning a *single* repeating namespace-scoped ID already clears the
8-byte Type `0` tax on its own, reversing the "need two IDs" framing for
the common case of small, hand-picked sequential IDs. Fixed both the
`§3.5` worked example and the DESIGN.md cost claim; the earlier "two
IDs" conclusion is kept as a correctly-scoped special case (Preview
repeating + Body reassembled once specifically), not a general rule.

### 25. `§2`'s "own URI scheme, skip magic" principle was asserted but never worked out — and pushing it one step further removes namespace-scoping's cost too, for the same reason

Checking `mofosyne/tagdrop`'s real SPEC.md directly (added to this
session, read rather than assumed) to answer whether their field
encoding was maps or arrays surfaced something more consequential: every
one of their codes is `tagdrop:<base41-cbor-sequence>` — their own URI
scheme, not byte-mode QR. Every cost comparison in this document up to
that point had been charging a 4-byte magic header per code, even though
§1/§2 already say an app with its own scheme shouldn't pay that cost.
The principle existed; it just hadn't been applied.

Pushed one step further, checking rather than assuming it stopped there:
does the same isolation that removes the need for magic also remove the
need for a declared namespace? Yes — namespace-scoping exists to let
unrelated apps' Type IDs coexist in a *shared, generic* container, and
an app whose carrier already guarantees nothing but its own decoder ever
sees these bytes has already solved that problem by a different,
pre-existing mechanism. A small self-allocated even Type ID (`32768`+,
no registry) is exactly as collision-safe in that deployment as a
namespace-scoped one, at a fraction of the cost.

**Verified against the real encoder, not estimated:** for a 4-code
group, the original comparison (magic + namespace-scoped, using the
already-corrected minimal odd-uint width from finding #24) cost 58 bytes
against TagDrop's own 8-byte envelope; dropping magic alone brings it to
42; dropping namespace-scoping too (self-allocated even ID) brings it to
20 — a 38-byte reduction from the original estimate, achieved entirely
by applying principles this document already stated rather than by
building anything new. The remaining ~12-byte gap reflects a real
capability difference (an open-ended, self-describing typeID vs.
TagDrop's closed 2-value enum), not waste, and is called out as such
rather than framed as more overhead to eliminate. (An earlier version of
this note said 68/+60/48-byte reduction — that reused the pre-#24
32769-width figure for this one row while the other two rows already
used the corrected width. Caught when a reader asked the table to
explain itself and the arithmetic didn't hold together; fixed to be
internally consistent.)

Fixed the actual gap this exposed: §2 had NDEF's magic-skip case fully
worked out (paragraph, example, prototype test) but nothing equivalent
for the URI-scheme case despite stating the same principle applies.
Added the matching paragraph, connected §3.5's namespace-skip guidance
to the same reasoning, and added
`prototype/test/custom-scheme-carrier.test.js`: a bare Sequence
round-tripping via the same `decodeSequence` path NDEF already
validated, `resolveLookupKey` confirming a self-allocated even ID needs
no namespace to resolve correctly with or without one declared, and the
corrected byte counts (14 vs. 4 per occurrence) asserted directly against
the encoder rather than left as a comment.

## Confirmed working as designed (no fix needed)

- **Magic + CBOR-Sequence-of-Records** round-trips exactly as
  drawn in §2's diagram, including rejecting bad magic.
- **Prefix-typeID routing (§3.1):** a Record encoded with no CBOR tag at
  all still routes correctly off prefix typeIDs alone — verified with a
  tag-free encoder path in the prototype. The tag path was later removed
  entirely (finding #12); this bullet just confirms prefix typeIDs alone
  were always sufficient, which is exactly why removing the other route
  cost nothing.
- **Even/odd criticality (§3.2):** an unrecognized even key aborts only
  that Record; an unrecognized odd key is silently ignored and the rest of
  the Record still processes; one aborted Record in a Sequence doesn't
  affect its siblings.
- **NDEF path (§2):** a bare CBOR Sequence with no magic prefix
  (simulating the `application/vnd.qdef` MIME-typed NDEF case) decodes via
  the same record-routing logic, confirming the magic header really is
  QR-path-only, not load-bearing for the container's actual structure.
- **The streaming claim (§2):** "a constrained parser can process each
  record as it streams in, without buffering the whole payload first" holds
  up against a real incremental CBOR decoder fed the byte sequence in
  arbitrary small chunks.
- **The Wrapper mechanism's core promise (§4.1):** one resolver function
  with no per-Record-Type knowledge correctly unwraps Split/Encrypt in
  combination and reassembles from fragments — including recovering a
  missing fragment (both a full-length one and the shorter last one) via
  XOR parity, and correctly failing when 2 of the 4 fragments (more than
  single-parity can cover) are missing.
- **Cross-implementation agreement:** containers encoded by the Node
  prototype's `cbor`-package-based encoder decode correctly through the
  Rust prototype's independent, hand-rolled decoder with no coordination
  beyond the spec text itself (`rust/qdef-core/src/fixtures.rs`) — the
  closest thing this exercise has to a real interop test between two
  unrelated implementations.

## Net effect on the spec

None of this changes three of the four load-bearing design decisions
called out as settled (two-layer core/standard-record-type split, even/odd criticality,
Wrapper Records over a sibling key range, fixed nesting order as encoder
convention). What changed for those is precision: several places that read
as complete prose turned out to be underspecified the moment two
independent implementations needed to agree on wire bytes without talking
to each other first. That gap is exactly what a prototype catches and
prose review doesn't.

The fourth — Hardware Parity dual routing — didn't survive: finding #12
removed the tag half of it outright. That's a genuine reversal of a
previously-settled decision, not just a precision fix, and it happened for
the same reason the others got sharpened: a concrete finding (§11's
reproduced IANA collision), not a stylistic second-guess.

The Rust pass added a second kind of value beyond the Node prototype: not
just "does the design round-trip," but "does the *minimal-core* claim,
specifically, survive contact with a language and target that can't lean on
a hosted CBOR library or an OS to hide the hard parts." It did — with two
concrete hardening gaps (#9, #10) that only became visible once the
CBOR-walking and Sequence-iteration logic had to be written by hand instead
of delegated to a library call.

## 23. Prefix typeIDs: replacing the three-tier integer system with a three-type classification

The original design used three tiers of integer Type IDs in key 0
(`1`–`99` standard record types, `100`–`32767` common vocabulary, `32768`+ private-use),
all encoded as CBOR uints. Namespace scoping was determined by a magnitude
check against a magic ceiling (`32768`). This worked but had structural
limitations:

- **Truncation was invisible on the wire.** A 64-bit private-use ID
  truncated to 32 bits was indistinguishable from a naturally-32-bit
  registered ID. The spec explicitly forbade this (old §3.5), but the
  prohibition was enforced by convention, not by the wire format.

- **The ceiling was a magic number.** `32768` carried semantic meaning
  (the boundary between "always global" and "namespace-scoped if declared")
  that wasn't visible in the CBOR encoding itself — a parser had to know
  the threshold.

- **Three tiers of the same type.** All three categories (standard,
  scoped, decentralized) were encoded as CBOR uints. A parser couldn't
  determine which category an ID belonged to without comparing against
  external thresholds.

The new design replaces tiers with three distinct CBOR types as prefix
typeIDs:

| CBOR type | Class | Scope |
|---|---|---|
| uint, even | Standard record type | Always global |
| uint, odd | Scoped record type | Requires namespace |
| byte string | Decentralized/random | Always global |

This change was adopted after research into analogous protocols (CBOR,
XML, NDEF, Protocol Buffers, HTTP/2+3, Bluetooth, ZIP) confirmed that
infrastructure mechanisms are universally kept globally interpretable —
matching the even-uint-always-global rule.

Key benefits:
- **Self-describing.** The CBOR major type and parity carry all the
  semantic meaning. No magic constants, no threshold comparisons.
- **Explicit truncation.** Byte string length visible on wire. A 2-byte
  ID visibly declares its collision tolerance.
- **Clean namespace scoping.** Odd uints require a namespace; even uints
  and byte strings are always global. No ceiling check needed.
- **Hash-derivation simplified.** Output is now a byte string (truncated
  SHA-256 digest), eliminating the old Number/BigInt comparison hazard
  (Finding #21) entirely.

Costs:
- **Breaking wire format change.** All existing fixtures must be
  regenerated. Containers using old odd-numbered types (3, 5, 7, 105)
  without a Type 0 header will be rejected.
- **Standard record type renumbering.** Types 3→8 (Compress), 5→10 (Fallback Hint),
  7→12 (App Route), 105→106 (Event Ticket) to ensure all standard record
  type IDs are even.
- **Prefix-typeID routing.** Parsers must now read the prefix typeID
  before entering the map, adding a step to the routing path. The
  prefix is a straightforward CBOR major-type check — trivial cost,
  but present.

### 26. The optional Type `0` header was structurally ambiguous with an ordinary Record's own prefix typeIDs — replaced with a mandatory container discriminator

Type `0` (§3.5) worked as an *optional* leading Record: a bare uint or
byte string, present or absent, MUST-be-first if present. Walking through
exactly how a decoder tells "the header is present" apart from "the
header is absent and this is just the first real Record's own prefix
typeID" surfaced a real structural gap: both cases are the identical CBOR
shape (uint or byte string) in the identical position. Tracing the
actual JS parser confirmed it: Phase-1 typeID accumulation
(`core.js`/`isTypeId`) accepts uint/bstr/tstr items with no way to
distinguish "this is a header" from "this is the second prefix item of
Record 1." A CBOR tag number could mark the difference unambiguously, but
tag-based routing was already rejected once for real collision risk
(Finding #11). The only remaining fix that resolves the ambiguity
structurally, rather than relying on encoder discipline that could be
violated, is to make the discriminator unconditionally present.

**Redesigned as a mandatory container discriminator**, always exactly
one CBOR item, always immediately after magic: `uint 0` (no namespace),
`uint N>0` (allocated namespace), byte string (decentralized namespace),
`[uint, bstr]` (allocated + decentralized backup), `[bstr, tstr]`
(decentralized + hint), or the full map form (extensible, same shape the
old Type `0` Record's own map had). An unrecognized shape degrades to
"no namespace," matching every other graceful-degrade path in this
format.

**This gives up "zero cost when unused"** — every container now pays at
least 1 byte, even one wanting no namespace. Initially rejected on that
basis (a mandatory tax on the common case), but reconsidered after being
pointed at the wrong framing: MCU-constrained parsing cost isn't this
project's actual binding constraint (smartphone-first; embedded scanners
are a nice-to-have), and a single byte answering "generic QDEF record vs.
specific application file format" is proportionally negligible against
any realistic payload — closer to RIFF's form-type byte than to wasted
padding. It also isn't purely a tax: the discriminator's shapes are each
cheaper than the old Type `0` Record's typeID+map framing, verified
against the actual encoder — a bare 4-byte decentralized namespace costs
5 bytes as a discriminator versus 8 bytes as the old optional Record,
enough that a single repeating namespace-scoped ID now nets a real win
per code rather than merely breaking even (see DESIGN.md's ["Container
discriminator redesign"](DESIGN.md#container-discriminator-redesign)).

**Verified the mandatory core stays minimal, not just asserted it.**
`rust/qdef-core`'s `Container::parse` needed exactly one addition — call
the crate's existing generic `skip_any_item` once to split the
discriminator off before parsing Records — and zero discriminator-shape
interpretation code. `header.js`'s `parseDiscriminator` is the only place
that understands what the six shapes mean.

**A real gap surfaced while implementing this: the Rust test suite was
green for the wrong reason.** After updating the JS encoder/decoder, all
60 Node tests passed as expected, but `cargo test` also reported all
green *before* `fixtures.rs` was regenerated — because `rust/qdef-core`
has zero discriminator-awareness of its own (by design), it was still
correctly parsing the *old*-format fixture bytes, never actually
exercising the new split-off-one-item behavior at all. A green Rust run
proved nothing here. Caught by reasoning through why that had to be
suspicious before trusting it, then confirmed for real by regenerating
`fixtures.rs` from the updated Node encoder and rerunning — which
surfaced two genuine failures (a stale fixture built by manually
concatenating magic + record bytes with no discriminator, and a
bare-NDEF-sequence test that stripped only magic off a full container,
leaving the discriminator byte in front of the real Record). Both fixed:
the manually-built fixture gained an explicit `uint 0` discriminator, and
the bare-sequence fixture was rebuilt directly via `encodeRecordBytes`
(bypassing `encodeContainer` entirely) instead of slicing a full
container — the same fix pattern already applied on the JS side in
`custom-scheme-carrier.test.js`. This is the general lesson, not
specific to this change: a cross-language fixture-based test only proves
what it was last regenerated against, and a decoder with intentionally
no semantic knowledge of a wire-format detail (by design, here) can stay
green on stale bytes indefinitely without ever really testing the new
shape.

### 27. "Multiple namespaces per container" was rejected for reasons specific to the two mechanisms considered, not to the goal itself — and the fix that avoids both isn't a cheaper decentralized ID either

Revisiting "Multiple namespaces per container" (previously "considered,
not built") after a concrete third design was proposed: a Record's own
prefix can carry a **namespace-pairing item**, `[namespace, typeId]`,
declaring/overriding that one Record's namespace independent of the
container discriminator's ambient one. Checking it against the two
previously-rejected mechanisms' actual objections — rather than assuming
the rejection generalized to "multi-namespace support is a bad
trade" — showed both objections were specific to those two shapes, not
to the goal: position-based re-scoping was rejected for introducing
stateful, order-dependent parsing (a pairing item needs none — it's
local to one Record, no cross-Record state); a header-level namespace
array with a per-Record selector was rejected for taxing *every*
namespace-scoped Record with a mandatory field (a pairing item is
opt-in, paid only by a Record that actually wants an override). Neither
objection applies to a self-contained, per-Record array.

**A related intuition needed checking too, and turned out wrong:**
whether this pairing form could also replace standalone decentralized
Record IDs (§3.1's byte string typeID), since a namespace + small odd
uint had already been shown cheaper than a standalone decentralized ID
*when amortized across multiple Records under one container-level
discriminator* (a separate finding). Verified against the actual
encoder rather than assumed: a per-Record pairing does **not**
amortize — it's paid fresh on every Record that carries one — so
`[decentralized namespace, scoped id]` costs 7 bytes bare versus 5 for a
plain standalone decentralized Record ID. The pairing form is strictly
worse for "I want one collision-safe global ID"; it only earns its cost
for the narrower question "can this one Record use a namespace other
than ambient." Caught before it was written into the spec as a
replacement it isn't.

Implemented identically in both languages, confirming the mandatory core
stays free of namespace semantics a second time: `core.js`'s Phase 1 and
`rust/qdef-core`'s `parse_record` each gained exactly one new
structural-recognition rule (a definite-length 2-element array at a
typeID position), with zero code anywhere in either mandatory core that
knows what a namespace *is* — matching the container discriminator's own
precedent (Finding #26) rather than needing a new pattern. See
DESIGN.md's "Multiple namespaces per container" and spec §3.1's
namespace-pairing prefix item.
