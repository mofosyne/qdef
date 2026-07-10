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

### 1. Hardware Parity: what happens when the tag and key 0 disagree?

§3.1 says a Record's CBOR tag and its `map[0]` carry "the *same* ID" but
never says what a decoder should do if they don't — e.g. a Record tagged
`105` whose `map[0]` says `100`. Left unspecified, a tag-aware decoder and a
constrained (key-0-only) decoder could each read a *different* Type ID out
of the identical bytes, silently disagreeing about what the Record even is.

**Fix:** a tag/key-0 mismatch is now a hard abort of that Record (same
class of failure as an unrecognized critical key) — verified in
`prototype/test/core.test.js`.

**Later superseded:** the tag route this finding is about no longer
exists — see finding #12. Kept here as an accurate record of what shipped
at the time; the mismatch case it fixed is moot once there's only one
route.

### 2. A Record with no key 0 at all

Not addressed anywhere. Key 0 is how *every* parser (tag-aware or not)
routes a Record, so a Record missing it can't be routed by anyone.

**Fix:** treat a missing key 0 the same as an unrecognized-critical-key
abort of that Record.

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
independent implementation of the mandatory core only (not the stdlib
Wrapper layer), written `#![no_std]`, with zero dependencies and zero heap
allocation — including hand-rolling the CBOR primitives instead of using a
crate for them, since using one would just re-test the Node prototype's
finding a second time.

### 8. The "minimal core" claim is true, and now has a number attached

Built in release mode for `thumbv6m-none-eabi` (Cortex-M0 — one of the most
constrained ARM targets in common use, no atomics beyond the basics), the
entire mandatory core — magic/version framing, full CBOR-Sequence walking,
key-0 routing, Hardware Parity mismatch detection, plus the even/odd
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
distinguishes "Record aborted but Sequence continues" (missing key 0, tag
mismatch — see findings #1–#2) from "Sequence itself is unrecoverable"
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

Types 2/3/4/5 (the entire Wrapper stdlib) and Type 100 (the flagship Wi-Fi
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

**Fix:** the tag route (the "Smart Route") is removed outright. Key `0` is
now the sole Record Type ID routing mechanism — §3.1 no longer describes
two routes, only one. This is a genuine simplification of the mandatory
core, not just a safer version of the old design: `rust/qdef-core`'s
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
through `map.set(0, typeId)` in `core.encodeRecordBytes`) would violate
both §3.1 (key `0` MUST be a plain uint) and §3.2's field-value-shape rule
(a value MUST NOT be a CBOR tag) — for the one field the entire
minimal-core-parser design depends on being trivially readable. It's the
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

## Confirmed working as designed (no fix needed)

- **Magic + version + CBOR-Sequence-of-Records** round-trips exactly as
  drawn in §2's diagram, including rejecting bad magic / wrong version.
- **Key-0-only routing (§3.1):** a Record encoded with no CBOR tag at all
  still routes correctly off `map[0]` alone — verified with a `tagged:
  false` encoder path in the prototype, back when a tagged path also
  existed to compare against. The tag path was later removed entirely
  (finding #12); this bullet just confirms key `0` alone was always
  sufficient, which is exactly why removing the other route cost nothing.
- **Even/odd criticality (§3.2):** an unrecognized even key aborts only
  that Record; an unrecognized odd key is silently ignored and the rest of
  the Record still processes; one aborted Record in a Sequence doesn't
  affect its siblings.
- **NDEF path (§2):** a bare CBOR Sequence with no magic/version prefix
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
called out as settled (two-layer core/stdlib split, even/odd criticality,
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
