'use strict';
// §2's "own URI scheme" magic-skip path, generalizing the existing NDEF
// case: an application whose carrier already dispatches to its own
// decoder (a URI scheme, an app-specific NDEF MIME type) needs no magic
// bytes, for the same reason NDEF doesn't -- the scheme prefix already
// did that job before any QDEF-specific parsing begins. Motivated by a
// real adopter, `mofosyne/tagdrop`, whose own `tagdrop:<base41-cbor-
// sequence>` scheme already provides exactly this dispatch today.
//
// Checked one level further than "does it decode": does an application
// in this position also need §3.5's namespace-scoping? No -- the same
// isolation argument that removes the need for magic bytes also removes
// the need for a declared namespace, since nothing but that
// application's own decoder will ever see these Type IDs. Verified with
// real byte counts, not asserted.

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const header = require('../src/header');

// A self-allocated even Type ID from the 32768+ First-Come-First-Served
// tier (spec §4's range table) -- no registry needed, and safe without a
// namespace specifically because this application's own URI scheme
// already ensures no other QDEF-aware decoder ever sees these bytes.
const PREVIEW_TYPE = 32768;
const BODY_TYPE = 32770;
const KNOWN_KEYS = new Set([0]);

test('a bare CBOR Sequence carried under a custom URI scheme round-trips with no magic bytes, via the same decodeSequence path NDEF uses', () => {
  const container = core.encodeContainer([
    { typeIds: [PREVIEW_TYPE], fields: new Map([[0, 'preview text']]) },
  ]);
  // Strip the magic prefix, simulating what actually goes on the wire
  // after a `myapp:` scheme prefix: just the bare Sequence.
  const bareSeq = container.subarray(core.MAGIC.length);

  assert.throws(() => core.decodeContainer(bareSeq), /bad magic/);

  const records = core.decodeSequence(bareSeq);
  const rec = core.applyCriticality(records[0], KNOWN_KEYS);
  assert.equal(rec.ignored, false);
  assert.equal(rec.typeId, PREVIEW_TYPE);
  assert.equal(rec.map.get(0), 'preview text');
});

test('the same self-allocated even Type ID needs no declared namespace to resolve correctly -- resolveLookupKey confirms it stays global with or without one', () => {
  const withoutNamespace = header.resolveLookupKey(undefined, PREVIEW_TYPE);
  const withUnrelatedNamespace = header.resolveLookupKey({ namespace: 999n }, PREVIEW_TYPE);

  assert.deepEqual(withoutNamespace, { scope: 'global', typeId: PREVIEW_TYPE });
  assert.deepEqual(withUnrelatedNamespace, { scope: 'global', typeId: PREVIEW_TYPE });
});

test('FINDING: skipping both magic and namespace-scoping is real, verified savings, not an estimate', () => {
  function bareCost(typeIds, fields) {
    return core.encodeRecordBytes({ typeIds, fields: fields || new Map() }).length;
  }

  const namespaceValue = Buffer.alloc(4, 0xcd);
  const type0Cost = bareCost([header.HEADER_TYPE], new Map([[header.HEADER_NAMESPACE_KEY, namespaceValue]]));
  const namespaceScopedPreviewCost = bareCost([1]); // smallest legal odd uint

  const selfAllocatedEvenCost = bareCost([PREVIEW_TYPE]);

  // Per-code cost, generic shared-container path: magic + repeated Type 0
  // header + namespace-scoped small odd uint.
  const sharedContainerPath = core.MAGIC.length + type0Cost + namespaceScopedPreviewCost;

  // Per-code cost, own-URI-scheme path: no magic (scheme already
  // dispatches), no Type 0 (scheme already isolates), self-allocated
  // even Type ID directly.
  const ownSchemePath = selfAllocatedEvenCost;

  assert.ok(
    ownSchemePath < sharedContainerPath,
    `own-scheme path (${ownSchemePath}) should cost less than the shared-container path (${sharedContainerPath})`,
  );
  // Verified, not asserted: the actual saving at time of writing.
  assert.equal(sharedContainerPath, 14);
  assert.equal(ownSchemePath, 4);
});
