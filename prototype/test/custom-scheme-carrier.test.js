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
const cbor = require('cbor');

const core = require('../src/core');
const header = require('../src/header');

// A self-allocated even Type ID from the 32768+ First-Come-First-Served
// tier (spec §4's range table) -- no registry needed, and safe without a
// namespace specifically because this application's own URI scheme
// already ensures no other QDEF-aware decoder ever sees these bytes.
const PREVIEW_TYPE = 32768;
const KNOWN_KEYS = new Set([0]);

test('a bare CBOR Sequence carried under a custom URI scheme round-trips with no magic bytes and no discriminator, via the same decodeSequence path NDEF uses', () => {
  // Built directly, not by stripping magic off encodeContainer's output --
  // a full container now also carries the mandatory discriminator item
  // right after magic, which this path deliberately has neither of.
  const bareSeq = core.encodeRecordBytes({
    typeIds: [PREVIEW_TYPE],
    fields: new Map([[0, 'preview text']]),
  });

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

test('FINDING: skipping magic, the discriminator, and namespace-scoping together is real, verified savings, not an estimate', () => {
  function bareCost(typeIds, fields) {
    return core.encodeRecordBytes({ typeIds, fields: fields || new Map() }).length;
  }

  const namespaceValue = Buffer.alloc(4, 0xcd);
  const discriminatorCost = cbor.encodeCanonical(namespaceValue).length;
  const namespaceScopedPreviewCost = bareCost([1]); // smallest legal odd uint

  const selfAllocatedEvenCost = bareCost([PREVIEW_TYPE]);

  // Per-code cost, generic shared-container path: magic + a decentralized-
  // namespace discriminator + a namespace-scoped small odd uint Record.
  const sharedContainerPath = core.MAGIC.length + discriminatorCost + namespaceScopedPreviewCost;

  // Per-code cost, own-URI-scheme path: no magic (scheme already
  // dispatches), no discriminator (scheme already isolates), self-
  // allocated even Type ID directly.
  const ownSchemePath = selfAllocatedEvenCost;

  assert.ok(
    ownSchemePath < sharedContainerPath,
    `own-scheme path (${ownSchemePath}) should cost less than the shared-container path (${sharedContainerPath})`,
  );
  // Verified, not asserted: the actual saving at time of writing. Lower
  // than earlier findings recorded (was 14) because the mandatory
  // discriminator item is itself cheaper than the old typeID(0)+map
  // Type 0 Record it replaced.
  assert.equal(sharedContainerPath, 11);
  assert.equal(ownSchemePath, 4);
});
