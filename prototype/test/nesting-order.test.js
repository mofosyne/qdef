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
    fields: new Map([[2, secretKeyBytes]]),
  });
  const encryptFields = wrappers.encryptEncode(innerRecordBytes, aesKey);
  const encryptRecordBytes = core.encodeRecordBytes({ typeId: wrappers.ENCRYPT_TYPE, fields: encryptFields });
  const fragmentMaps = wrappers.splitEncode(encryptRecordBytes, { count: 3, parityScheme: wrappers.PARITY_SCHEME_XOR });
  const codes = fragmentMaps.map((f) => core.encodeContainer([{ typeId: wrappers.SPLIT_TYPE, fields: f }]));

  const terminal = wrappers.resolveStack(codes, { aesKey }, KNOWN_KEYS_REGISTRY);
  assert.equal(terminal.typeId, rt.PGP_BACKUP_TYPE);
  assert.ok(terminal.map.get(2).equals(secretKeyBytes));
});

test('FINDING: a reversed, non-conformant order (Encrypt-per-code outermost, Split innermost) ALSO resolves cleanly', () => {
  // This is exactly the order §4.1 says NOT to use ("Split must be
  // outermost"). Built anyway, to check whether the generic resolver can
  // tell the difference.
  const secretKeyBytes = crypto.randomBytes(80);
  const aesKey = crypto.randomBytes(32);

  const innerRecordBytes = core.encodeRecordBytes({
    typeId: rt.PGP_BACKUP_TYPE,
    fields: new Map([[2, secretKeyBytes]]),
  });
  // Split the PLAIN record first (Split innermost)...
  const fragmentMaps = wrappers.splitEncode(innerRecordBytes, { count: 3, parityScheme: wrappers.PARITY_SCHEME_XOR });
  // ...then encrypt each fragment individually, per code (Encrypt outermost).
  const codes = fragmentMaps.map((fragMap) => {
    const fragRecordBytes = core.encodeRecordBytes({ typeId: wrappers.SPLIT_TYPE, fields: fragMap });
    const encField = wrappers.encryptEncode(fragRecordBytes, aesKey); // fresh nonce per fragment
    return core.encodeContainer([{ typeId: wrappers.ENCRYPT_TYPE, fields: encField }]);
  });

  // No exception, no rejection: the resolver has no concept of "wrong
  // order" — it just keeps unwrapping whatever wrapper Type ID it sees.
  const terminal = wrappers.resolveStack(codes, { aesKey }, KNOWN_KEYS_REGISTRY);
  assert.equal(terminal.typeId, rt.PGP_BACKUP_TYPE);
  assert.ok(terminal.map.get(2).equals(secretKeyBytes));
});
