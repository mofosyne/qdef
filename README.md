# QDEF — Quick Data Exchange Format

QDEF is a general-purpose binary container for multi-action 2D barcodes (QR,
Data Matrix, Aztec) and NFC tags. It plays the role for optical/byte-mode
payloads that [NDEF](https://en.wikipedia.org/wiki/NFC_Data_Exchange_Format)
already plays for NFC — "carry one or more typed records in a single
scan/tap" — a container format that doesn't exist today for the plain
byte-mode QR case.

A single QDEF payload can carry several independent, unrelated pieces of
information at once — a Wi-Fi credential and an event ticket on the same
sticker, for example — where each piece is parsed by whichever app
recognizes its type and ignored by every app that doesn't.

## Status

**Draft, not yet implemented as a reference library.** The design in
[`docs/QDEF-SPEC.md`](docs/QDEF-SPEC.md) has been validated by two
throwaway prototypes:

- [`/prototype`](prototype) (Node) — real code encoding and decoding real
  QDEF bytes end to end, including the multi-fragment split/encrypt worked
  example with fragment-loss recovery.
- [`/rust/qdef-core`](rust/qdef-core) (Rust, `#![no_std]`) — an independent
  reimplementation of just the mandatory core, with hand-rolled CBOR
  primitives and zero dependencies, that also builds for a bare-metal
  Cortex-M0 target — checking the spec's "a deeply constrained scanner can
  implement this" claim against an actual constrained target rather than
  leaving it as prose.

Neither has been used in production anywhere, and Record Type IDs
referenced in the spec (`100`, `105`, `900`, `950`, etc.) are illustrative
placeholders, not an allocated registry.

See [`docs/FINDINGS.md`](docs/FINDINGS.md) for what both prototypes found
and fixed — several real interop and hardening gaps that careful prose
review alone hadn't caught.

## Why QDEF

Existing text barcode schemas (`WIFI:S:...;;`, `BEGIN:VCARD`) are rigid,
single-purpose, and text-only. NDEF solves multi-record framing, but only
for NFC. Nothing today fills the equivalent role for a plain byte-mode
optical code, or for an NFC payload with no application-specific MIME type
already routing it.

QDEF is:

- **Binary-first**, not text-safe — no alphanumeric-mode constraint, so no
  base32/base41-style encoding overhead.
- **Multi-action** — a CBOR Sequence of Records, so unrelated applications
  can share one physical code.
- **Layered**, on purpose: a minimal mandatory *core* (routing and
  criticality only) plus a separate, optional *standard library*
  (splitting a payload across multiple codes, compression, encryption, a
  generic fallback hint) — the same relationship C-the-language has with
  libc. A minimal implementer never needs a compression or reassembly
  library just to route Records.
- **Usable by a deeply constrained scanner.** Every Record's type is
  readable at zero decode cost from a plain map key — no CBOR tag support
  needed, no semantic-tag-aware library at all. QDEF doesn't use CBOR tags
  for routing (an earlier draft did; dropped after finding it collided
  with the IANA tag registry — see `docs/FINDINGS.md` #11–#12).

QDEF is meant for adoption by unrelated applications with no shared
history. The format's own spec works through a Wi-Fi-provisioning example
and a full worked example of backing up a passphrase-protected secret key
across several printed QR codes — see §5 and §8 of the spec.

**When QDEF is *not* the right fit:** if your application already has its
own text/URI scheme (something a user could type or click), encode your
data directly under that scheme instead of wrapping it in QDEF — the scheme
prefix already does the recognition job QDEF's magic header exists for.
QDEF earns its place on carriers with no pre-existing dispatch: a plain
byte-mode QR with no URI at all, or an NFC payload with no app-specific
MIME type already routing it.

## Repository layout

- [`docs/QDEF-SPEC.md`](docs/QDEF-SPEC.md) — the format specification
  (normative).
- [`docs/DESIGN.md`](docs/DESIGN.md) — why the spec looks the way it does:
  mechanisms tried and removed, alternatives weighed and rejected, and
  what's still unresolved. Non-normative.
- [`docs/FINDINGS.md`](docs/FINDINGS.md) — what the round-trip prototype
  found and changed in the spec.
- [`prototype/`](prototype) — a throwaway Node.js implementation used to
  validate the design by actually encoding and decoding QDEF bytes. Not a
  reference library; see its own README for scope and how to run it.
- [`rust/qdef-core/`](rust/qdef-core) — a throwaway `#![no_std]` Rust
  reimplementation of just the mandatory core, used to check that layer's
  "genuinely minimal, no CBOR library required" claim against a real
  bare-metal target. Not a reference library either; see its own README.

## Origin

QDEF's design was first worked out while building
[`mofosyne/tagdrop`](https://github.com/mofosyne/tagdrop), a dead-drop/QR
content-sharing app that needed exactly this kind of container for its own
byte-mode QR/NFC path. TagDrop is one adopter of QDEF, not the reason the
format exists — the spec is written for, and the worked examples include,
applications with nothing to do with TagDrop.
