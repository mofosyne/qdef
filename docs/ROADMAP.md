# QDEF — Roadmap

Where this project actually is, what's deliberately left undone, and
where it's headed — for anyone landing on this repo cold. See
[`QDEF-SPEC.md`](QDEF-SPEC.md) for the format itself,
[`DESIGN.md`](DESIGN.md) for why it looks the way it does, and
[`FINDINGS.md`](FINDINGS.md) for what two rounds of actually building it
found that prose review didn't.

## Done

**The core is validated, not just written.** Magic framing, the
unified root/subrecord Record grammar (the container root is an
ordinary Record — one self-delimited CBOR array, the identical shape a
subrecord already uses — with typeID optional and defaulting to Bundle
when omitted, no separate discriminator item), per-Record prefix
typeID routing, and the even/odd criticality rule have each been built
twice, independently — a Node prototype covering the full design, and
a `#![no_std]`, zero-dependency Rust prototype of just the mandatory
core that also builds for a bare-metal Cortex-M0 target.
Cross-validated against each other (the Rust decoder parses containers
the Node encoder produced, not just its own output); test counts have
grown substantially past any specific number quoted here — see each
prototype's own `test/` directory for current coverage rather than
trusting a number in this document to stay current.

**The standard library is complete and tested**, not aspirational:

- **Split** (fragmenting a payload across multiple codes, with optional
  XOR single-fragment parity)
- **Compress** (DEFLATE)
- **Encrypt** (AES-GCM-class ciphers, with optional Algorithm/Key
  Algorithm fields borrowing IANA's COSE Algorithms registry rather than
  inventing one)
- **Open/Hint URI** (a URI a generic tool can follow even with no
  QDEF-specific support — as a lone primary URI or as a fallback
  alongside other Records)
- **Media Payload** (a standard media blob — image, document — tagged
  with IANA's CoAP Content-Formats registry or a plain MIME string)
- **App Route** (letting a generic scanner offer to launch a specific
  handling application, comparable to NFC's Android Application Record,
  using a domain-verified identifier rather than an unverifiable string
  claim — plus a second, hash-derived form for scanners that just need
  a fast, no-authority misread pre-filter ahead of reassembly)
- **Media Preview** (content identification — media type, content hash,
  filename, label — with the identified content itself riding as a
  subrecord, typically Media Payload; came from a live TagDrop proposal,
  refined over two rounds to fix a nesting-order bug that would have
  broken old Split-only decoders' reassembly)

Every one of these round-trips in the Node prototype; none is spec-text
only.

**Signature** (§4.7, Type `16`) is also built and round-trips, but on a
different footing than the rest of this list: it's an MVP explicitly
scoped to the positional/checkpoint coverage strategy (NDEF Signature
RTD parity, plus the Bundle-scoped case for free) rather than the
general cross-tree hash-list form DESIGN.md still calls "decided, not
yet built," and it was built to explore the coverage mechanism's own
dynamics ahead of an actual signing request rather than a real
adopter's shipped need — a deliberate, acknowledged departure from the
discipline the rest of this document holds to (FINDINGS.md #50).
Checked against `mofosyne/tagdrop`'s real signed set immediately
after: confirms the MVP's own stated boundary exactly (their Records
sit at heterogeneous, Split-dependent nesting depths this positional
form can't express) and surfaces two further gaps the still-unbuilt
hash-list direction doesn't close either — a deliberate cost split
between cheap-repeated and expensive-once fields, and a non-
strippability guarantee neither Sign direction currently has
(FINDINGS.md #51). Both flagged as open, not glossed over.

**Format-wide mechanisms resolved and prototyped:** every Record —
subrecord or root alike — is one self-delimited CBOR array (§3.1) —
`[namespace?, typeId?, map?, payload?, subrecord*]`, typeId defaulting
to `0` (Bundle) when omitted — so a single primary Record can sit at
the root with zero indirection while several co-equal Records fall
back to Bundle and become the root's own subrecords (FINDINGS.md #52,
superseding the earlier mandatory discriminator; #53 closed a real
boundary gap in the root's own framing by array-wrapping it too, so
bytes appended after the container are provably outside it rather than
guessed at from where the buffer happens to end). Any decoder can skip
a whole Record it doesn't care about using nothing but ordinary CBOR
array-skipping, with no Record-grammar knowledge at all, and a
malformed inner Record can no longer corrupt discovery of its siblings
(FINDINGS.md #41). Subrecords
generalize what was briefly a narrower `ID[]{}` mechanism into the same
recursive grammar used everywhere else, resolving a real correlation
problem TagDrop's own Media Preview/Payload proposal ran into. Also
resolved: the payload slot (an optional CBOR item — any well-formed
shape except an array, so it's never ambiguous with a subrecord, no
marker needed — carrying a Wrapper Record's opaque content or a
Record's own direct application data, saving real bytes on every
Wrapper Type — Compress, Encrypt, and Split's own fragment bytes no
longer need a map key at all) and the field Map
itself becoming optional (omitted entirely when empty, another byte
saved on every fieldless Record), namespace-scoped Type IDs and their
hash-derivation self-certification
(§3.5, the general-purpose primitive Type Hint originally introduced
before being retired alongside decentralized Type IDs — see
FINDINGS.md), and canonical encoding (§3.4, RFC 8949's deterministic
CBOR rules as a MUST for encoders, closing a live gap in `group_id`'s
integrity guarantee before it saw real use). **Common Field Keys**
(§3.6) closed the actual NDEF-`ID` gap the payload slot never did — a
small, spec-governed, Type-independent vocabulary living entirely in
negative map keys (`ID`, `UUID`, `Date`, `Label`, `Language`, `Content
Hash`), reusing the existing even/odd criticality rule rather than
inventing a new one, made trustworthy only once a real JS/Rust
disagreement over negative-key parity was fixed (FINDINGS.md #47).

**Checked against a real adopter, not just designed in the abstract.**
`mofosyne/tagdrop` — the project QDEF's design was first worked out
alongside — confirmed its own sectorization already matches Split's
uniform-chunking rule, its own signing already covers the
fully-reassembled-stream case without needing a QDEF Sign mechanism, and
its §6-pattern registration is ready to use today. The same check also
surfaced a real limitation (documented, not hidden): TagDrop's
deliberately-undeclared encryption can't map onto the Encrypt Wrapper,
because being wrapped in a Type-`4` Record is itself a visible
declaration — a genuine scope boundary, not a bug (FINDINGS.md #13).

**A standalone grammar-and-footgun linter for any encoder's output**
(`prototype/scripts/qdef-lint.js`), motivated by TagDrop wanting
something bolt-on-able to their own encoder, not tied to this
prototype's. Grammar checking mirrors `rust/qdef-core`'s own CBOR
primitives rather than reusing `core.js` or the `cbor` npm package, so
the algorithm — not this specific JS — is the portable artifact.
Footgun checking (a CBOR bignum tag where a native-uint typeId was
meant, non-canonical encoding, duplicate/misordered map keys) is
layered on top; a "namespace present, typeId absent" check was tried
and dropped after it fired on the single most standard root shape in
the spec (see FINDINGS.md). A CDDL schema was tried first and rejected
— see FINDINGS.md for why the standard tooling couldn't actually
validate QDEF's grammar, not just an assumption.

**The reference encoder now requires `typeId` explicitly, the wire
format doesn't change at all.** `prototype/src/core.js`'s
`recordToItems` throws if `typeId` is omitted at call time, closing
exactly the ambiguity the dropped footgun check above had to declare
undecidable from bytes alone — the encoder always knows whether it
meant a Bundle or forgot a typeId, even when the resulting bytes can't
say. Wire-mandatory typeId was considered and rejected first: it would
reopen the "any well-formed array decodes as some valid Record"
guarantee root unification specifically bought, and tax every
compliant encoder's actual Bundle records forever. `typeId: 0` is still
omitted from the wire exactly as before; `rust/qdef-core` and every
existing container are untouched (see FINDINGS.md).

**Payload narrowed to byte string or text string only, closing a real
silent-data-loss bug.** A bare uint or byte-string payload with `typeId:
0` and no namespace used to decode back with the payload silently
reinterpreted as typeId or namespace and gone entirely — found while
tracing why the mandatory-typeId change above still felt like a special
case for one particular shape. Rather than add a fourth guard mechanism
alongside the three `recordToItems` already had (array/record-spec
throw, map-shaped auto-inserted an empty field Map), the fix removes
the ambiguous shapes: a conformant encoder now emits only bstr/tstr as
payload, and the one truly unremovable collision (byte-string payload
at position 0, indistinguishable from namespace) is now a loud
call-time throw instead of a silent trap. Wire format and decoder both
unchanged (see FINDINGS.md).

## Deliberately not done yet

- **Sign's general cross-tree coverage (the hash-list form).** Direction
  is decided (content-hash-based coverage, sibling not wrapper form) and
  its prerequisite (canonical encoding) is resolved, but it's not built
  — the positional/checkpoint form shipped instead for the narrower
  same-array case (§4.7, above). Waiting for a real adopter's actual
  need for arbitrary cross-tree coverage, the same discipline every
  other entry here is held to, and the one the positional MVP itself
  already departed from once.
- **Registry governance authority.** No body currently allocates
  application Type IDs (`100`+) officially, for either the
  Specification Required (`100`–`32767`) or First Come First Served
  (`32768`+) tier; everything in the spec today is an illustrative
  placeholder — unless an adopter instead declares its own namespace
  (§3.5, always a self-chosen byte string) and uses namespace-scoped
  odd uints, which need no authority at all, ever, by design — see
  `DESIGN.md`'s "Governed vs. ungoverned, made explicit" for the full
  breakdown of which tier needs what. See "Where this is headed" below.
- **Split's general per-code capacity flexibility.** Costs nothing
  against TagDrop's own design specifically; an adopter needing
  heterogeneous fragment sizes across physically different codes still
  hits a real, open constraint.
- **A production-grade reference library.** Everything validated so far
  is explicitly throwaway (see both prototypes' own READMEs) — proof the
  design works, not something meant to be depended on.

## Where this is headed

**Near-term:** `mofosyne/tagdrop` adopting the §6 registration pattern in
its real codebase is the next actual milestone — a live pressure test,
not another design pass. Stewardship of the spec itself is intended to
move to **NFCDAB**, a wireless-art collective in the same spirit as
existing QR-art and NFC-art communities, taking on the registry-
governance role that's explicitly unresolved today.

**Longer-term:** the aim is eventual formal standardization — an IANA
registry and an RFC — once the format has real-world adoption and a
stable maintaining body behind it, rather than pursuing that path before
either exists.

This roadmap will drift out of date as work lands; check `git log` on
this file or the repo's recent commits for what's actually current.
