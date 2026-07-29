'use strict';
// Integration coverage for header.js's namespace-cascade resolution
// (§3.5) against real encoded/decoded bytes, not just isolated unit
// values. Mirrors the two cases a real adopter (TagDrop) asked about:
// cascading through a namespaced Bundle root (works), and cascading
// through an intervening global standard-type Record (doesn't — the
// chain breaks and must be re-declared explicitly).

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');
const header = require('../src/header');

const TAGDROP_NS = Buffer.from('89d414e0', 'hex');

test('cascade: namespaced Bundle root, h\'\' subrecord inherits, global sibling stays global', () => {
  const contentExtension = {
    localNamespace: Buffer.alloc(0), // h'' = inherit
    typeId: [1],
    fields: new Map([[3, 'hi']]),
  };
  const mediaPayload = {
    typeId: [3],
    fields: new Map([[0, Buffer.from([0x89])]]),
  };
  const mediaPreview = {
    typeId: [7],
    fields: new Map([[2, 'image/png']]),
    subrecords: [mediaPayload],
  };
  const root = {
    localNamespace: TAGDROP_NS,
    subrecords: [contentExtension, mediaPreview],
  };

  const bytes = core.encodeContainer(root);
  const decoded = core.decodeContainer(bytes);
  header.resolveNamespacesDeep(decoded, undefined);

  assert.ok(decoded.effectiveNamespace.equals(TAGDROP_NS), 'root keeps its own explicit namespace');

  const [decodedContentExt, decodedMediaPreview] = decoded.subrecords;
  assert.ok(
    decodedContentExt.effectiveNamespace.equals(TAGDROP_NS),
    'h\'\' subrecord inherits the root\'s namespace'
  );
  assert.deepEqual(decodedContentExt.typeId, [1]);

  assert.equal(
    decodedMediaPreview.effectiveNamespace,
    undefined,
    'a standard global type with no namespace of its own stays global, even nested under a namespaced Bundle'
  );
  const decodedMediaPayload = decodedMediaPreview.subrecords[0];
  assert.equal(
    decodedMediaPayload.effectiveNamespace,
    undefined,
    'global-ness propagates: nothing under an unnamespaced Record inherits from further up'
  );
});

test('cascade: chain breaks through global ancestors — scoped Record must redeclare explicitly', () => {
  const contentSignature = {
    localNamespace: TAGDROP_NS, // explicit — required here, h'' would have nothing to inherit
    typeId: [2],
    fields: new Map([[3, Buffer.from([0xaa])]]),
  };
  const mediaPayload = {
    typeId: [3],
    fields: new Map([[0, Buffer.from([0x89])]]),
    subrecords: [contentSignature],
  };
  const mediaPreview = {
    typeId: [7],
    fields: new Map([[2, 'image/png']]),
    subrecords: [mediaPayload],
  };

  const bytes = core.encodeContainer(mediaPreview);
  const decoded = core.decodeContainer(bytes);
  header.resolveNamespacesDeep(decoded, undefined);

  const decodedSignature = decoded.subrecords[0].subrecords[0];
  assert.ok(
    decodedSignature.effectiveNamespace.equals(TAGDROP_NS),
    'explicit namespace resolves correctly, independent of the unnamespaced ancestors above it'
  );
});

test('cascade: h\'\' with nothing to inherit resolves to no namespace, not some further ancestor\'s', () => {
  // Same shape as the previous test, but the deeply-nested Record
  // wrongly tries h'' instead of declaring its own namespace. Its
  // immediate parent (mediaPayload) has no namespace, so there is
  // nothing to inherit -- even though the outermost Record in this
  // tree could have had one, cascade does not skip through the global
  // ancestor to reach it.
  const brokenAttempt = {
    localNamespace: Buffer.alloc(0), // h'' -- invalid here, nothing to inherit
    typeId: [2],
    fields: new Map([[3, Buffer.from([0xaa])]]),
  };
  const mediaPayload = {
    typeId: [3],
    fields: new Map([[0, Buffer.from([0x89])]]),
    subrecords: [brokenAttempt],
  };
  const mediaPreview = {
    typeId: [7],
    fields: new Map([[2, 'image/png']]),
    subrecords: [mediaPayload],
  };

  const bytes = core.encodeContainer(mediaPreview);
  const decoded = core.decodeContainer(bytes);
  // Even seeding a real ambient namespace at the very top of the walk
  // doesn't help -- the global mediaPreview/mediaPayload Records break
  // the chain before it ever reaches the h'' attempt.
  header.resolveNamespacesDeep(decoded, TAGDROP_NS);

  const decodedBroken = decoded.subrecords[0].subrecords[0];
  assert.equal(
    decodedBroken.effectiveNamespace,
    undefined,
    'h\'\' resolves to nothing when its immediate parent has no namespace -- this typeId is genuinely ambiguous with the global standard type at the same number'
  );
});
