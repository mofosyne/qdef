'use strict';
// Integration coverage for header.js's namespace-cascade resolution
// (§3.5) against real encoded/decoded bytes, not just isolated unit
// values. Mirrors the cases a real adopter (TagDrop) asked about:
// cascading through a namespaced Bundle root, and cascading through
// intervening global standard-type Records, which now correctly pass
// the ambient namespace through to their own subrecords even though
// their own typeId stays global.

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');
const header = require('../src/header');

const TAGDROP_NS = Buffer.from('89d414e0', 'hex');

test('cascade: namespaced Bundle root, h\'\' subrecord inherits, global sibling stays global itself', () => {
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
    'a standard global type\'s OWN typeId stays global, even nested under a namespaced Bundle'
  );
  const decodedMediaPayload = decodedMediaPreview.subrecords[0];
  assert.equal(
    decodedMediaPayload.effectiveNamespace,
    undefined,
    'and so does a further-nested global type\'s own typeId'
  );
});

test('cascade: h\'\' reaches through global standard-type ancestors to a namespace declared higher up', () => {
  // The exact structure TagDrop asked about: a scoped Content Signature
  // nested three levels deep, under two global standard types (Media
  // Preview -> Media Payload) that never carry a namespace of their
  // own. Even though neither ancestor's OWN typeId is scoped, both
  // still pass the root's namespace through to what's nested inside
  // them -- so h'' on Content Signature now correctly resolves,
  // instead of needing its own explicit (and more expensive) namespace.
  const contentSignature = {
    localNamespace: Buffer.alloc(0), // h'' -- now valid here
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
  const root = {
    localNamespace: TAGDROP_NS,
    subrecords: [mediaPreview],
  };

  const bytes = core.encodeContainer(root);
  const decoded = core.decodeContainer(bytes);
  header.resolveNamespacesDeep(decoded, undefined);

  const decodedMediaPreview = decoded.subrecords[0];
  const decodedMediaPayload = decodedMediaPreview.subrecords[0];
  const decodedSignature = decodedMediaPayload.subrecords[0];

  assert.equal(decodedMediaPreview.effectiveNamespace, undefined, 'Media Preview stays global for itself');
  assert.equal(decodedMediaPayload.effectiveNamespace, undefined, 'Media Payload stays global for itself');
  assert.ok(
    decodedSignature.effectiveNamespace.equals(TAGDROP_NS),
    'h\'\' on Content Signature resolves through both global ancestors to the root\'s namespace'
  );
});

test('cascade: an explicit namespace still works at any depth, independent of ambient', () => {
  const contentSignature = {
    localNamespace: TAGDROP_NS, // explicit -- valid regardless of what ambient (if any) is flowing
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

test('cascade: h\'\' with nothing declared anywhere in the tree resolves to no namespace', () => {
  const brokenAttempt = {
    localNamespace: Buffer.alloc(0), // h'' -- nothing anywhere in this tree declared a namespace
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
  header.resolveNamespacesDeep(decoded, undefined);

  const decodedBroken = decoded.subrecords[0].subrecords[0];
  assert.equal(
    decodedBroken.effectiveNamespace,
    undefined,
    'h\'\' with no ambient anywhere in the tree resolves to no namespace -- this typeId is genuinely ambiguous with the global standard type at the same number'
  );
});
