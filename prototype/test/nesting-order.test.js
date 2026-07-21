'use strict';
// Investigates docs/DESIGN.md's open question: "Is nesting order just
// documented convention, or should decoders detect/reject a non-conformant
// order?"
//
// Uses wrappers.resolveStack — a generic, type-directed recursive resolver
// (exactly the "one resolver, written once" mechanism §4.1 describes) — to
// see whether a decoder written the natural way can even tell the
// difference between the documented order and a reversed one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const core = require('../src/core');
const wrappers = require('../src/wrappers');
const rt = require('../src/recordTypes');

const KNOWN_KEYS_REGISTRY = new Map([
  [wrappers.SPLIT_TYPE, wrappers.SPLIT_KNOWN_KEYS],
  [wrappers.COMPRESS_TYPE, wrappers.COMPRESS_KNOWN_KEYS],
  [wrappers.ENCRYPT_TYPE, wrappers.ENCRYPT_KNOWN_KEYS],
  [rt.PGP_BACKUP_TYPE, rt.PGP_BACKUP_KNOWN_KEYS],
]);

test('canonical order (Split outermost -> Encrypt -> plain) resolves via the generic resolver', () => {
  const secretKeyBytes = crypto.randomBytes(80);
  const aesKey = crypto.randomBytes(32);

  const innerRecordBytes = core.encodeRecordBytes({
    typeId: rt.PGP_BACKUP_TYPE,
    fields: new Map([[0, secretKeyBytes]]),
  });
  const enc = wrappers.encryptEncode(innerRecordBytes, aesKey);
  const encryptRecordBytes = core.encodeRecordBytes(enc);
  const fragmentRecords = wrappers.splitEncode(encryptRecordBytes, { count: 3, parityScheme: wrappers.PARITY_SCHEME_XOR });
  const codes = fragmentRecords.map((f) => core.encodeContainer([f]));

  const terminal = wrappers.resolveStack(codes, { aesKey }, KNOWN_KEYS_REGISTRY);
  assert.equal(terminal.typeId, rt.PGP_BACKUP_TYPE);
  assert.ok(terminal.map.get(0).equals(secretKeyBytes));
});

test('FINDING: a reversed, non-conformant order (Encrypt-per-code outermost, Split innermost) ALSO resolves cleanly', () => {
  const secretKeyBytes = crypto.randomBytes(80);
  const aesKey = crypto.randomBytes(32);

  const innerRecordBytes = core.encodeRecordBytes({
    typeId: rt.PGP_BACKUP_TYPE,
    fields: new Map([[0, secretKeyBytes]]),
  });
  const fragmentRecords = wrappers.splitEncode(innerRecordBytes, { count: 3, parityScheme: wrappers.PARITY_SCHEME_XOR });
  const codes = fragmentRecords.map((fragRec) => {
    const fragRecordBytes = core.encodeRecordBytes(fragRec);
    const enc = wrappers.encryptEncode(fragRecordBytes, aesKey);
    return core.encodeContainer([enc]);
  });

  const terminal = wrappers.resolveStack(codes, { aesKey }, KNOWN_KEYS_REGISTRY);
  assert.equal(terminal.typeId, rt.PGP_BACKUP_TYPE);
  assert.ok(terminal.map.get(0).equals(secretKeyBytes));
});
