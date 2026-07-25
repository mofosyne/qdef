'use strict';
// §4.6's Bundle (Type 0): a structural Record, not a wrapper and not
// application data -- its own field Map only carries a namespace hint
// (key 3) and backup namespace (key 5) now that namespace itself is
// positional (§3.1), not a map key. Bundle's meaning otherwise lives
// entirely in its subrecords. Exists for the case where an application
// wants an explicit boundary around a set of Records (a generic tool
// can recognize without reading every Record's typeId) or wants to
// scope a namespace override across several Records without repeating
// it on each one. It's also, now, what the root of every container
// implicitly is whenever typeId is omitted there (§2/§3.1).

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const header = require('../src/header');
const rt = require('../src/recordTypes');

test('a Bundle round-trips with an omitted empty map and its subrecords intact', () => {
  const bytes = core.encodeRecordBytes({
    typeId: rt.BUNDLE_TYPE,
    subrecords: [
      { typeId: 100, fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) },
      { typeId: 10, fields: new Map([[0, 'https://example.com/open']]) },
    ],
  });

  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.typeId, rt.BUNDLE_TYPE);
  assert.equal(rec.map, null); // empty map omitted on the wire, not present
  assert.equal(rec.subrecords.length, 2);
  assert.equal(rec.subrecords[0].typeId, 100);
  assert.equal(rec.subrecords[0].map.get(0), 'SSID');
  assert.equal(rec.subrecords[1].typeId, 10);
  assert.equal(rec.subrecords[1].map.get(0), 'https://example.com/open');
});

test('an application with no interest in Bundle skips the whole Record (and its subrecords) cleanly by Type ID alone', () => {
  const container = core.encodeContainer({
    typeId: 0,
    subrecords: [
      {
        typeId: rt.BUNDLE_TYPE,
        subrecords: [{ typeId: 100, fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) }],
      },
      { typeId: 10, fields: new Map([[0, 'https://example.com/open']]) },
    ],
  });

  const root = core.decodeContainer(container);
  const records = root.subrecords;
  const KNOWN_TYPES = new Map([[10, new Set([0, 1, 3, 5])]]); // no entry for Type 0
  const handled = records
    .filter((r) => KNOWN_TYPES.has(r.typeId))
    .map((r) => core.applyCriticality(r, KNOWN_TYPES.get(r.typeId)));

  assert.equal(records.length, 2);
  assert.equal(handled.length, 1);
  assert.equal(handled[0].typeId, 10);
});

test('Bundle scopes a namespace override across its subrecords without repeating it on each one', () => {
  const namespace = Buffer.from('cdcdcdcd', 'hex');
  const bytes = core.encodeRecordBytes({
    typeId: rt.BUNDLE_TYPE,
    localNamespace: namespace,
    subrecords: [
      { typeId: 1, fields: new Map([[0, 'scoped by bundle namespace']]) },
      { typeId: 3, fields: new Map([[0, 'same scope, no per-record namespace paid']]) },
    ],
  });

  const rec = core.decodeRecordBytes(bytes);
  const resolved = header.resolveLookupKeysDeep(rec, undefined);

  // resolved[0] is the Bundle itself (even, global); resolved[1]/[2] are
  // its subrecords, both odd and both cascading the Bundle's namespace.
  assert.equal(resolved.length, 3);
  assert.equal(resolved[0].key.scope, 'global');
  assert.equal(resolved[1].key.scope, 'namespace');
  assert.ok(resolved[1].key.namespace.equals(namespace));
  assert.equal(resolved[2].key.scope, 'namespace');
  assert.ok(resolved[2].key.namespace.equals(namespace));
});

test('an unexpected key in a Bundle\'s field Map is criticality-checked normally -- an even key not in {3, 5} aborts', () => {
  const bytes = core.encodeRecordBytes({
    typeId: rt.BUNDLE_TYPE,
    fields: new Map([[2, 'unexpected critical field']]), // even, unrecognized -> abort
    subrecords: [{ typeId: 100, fields: new Map([[0, 'SSID']]) }],
  });

  const rec = core.applyCriticality(core.decodeRecordBytes(bytes), rt.BUNDLE_KNOWN_KEYS);
  assert.equal(rec.aborted, true);
});

test('a Bundle\'s hint (key 3) and backup namespace (key 5) are recognized as odd/optional -- a decoder unaware of them just ignores, never aborts', () => {
  const namespace = Buffer.from('cdcdcdcd', 'hex');
  const bytes = core.encodeRecordBytes({
    typeId: rt.BUNDLE_TYPE,
    localNamespace: namespace,
    fields: new Map([
      [rt.BUNDLE_HINT_KEY, 'com.example/tagdrop'],
      [rt.BUNDLE_BACKUP_NAMESPACE_KEY, Buffer.from('ab', 'hex')],
    ]),
  });

  const rec = core.applyCriticality(core.decodeRecordBytes(bytes), rt.BUNDLE_KNOWN_KEYS);
  assert.equal(rec.aborted, false);
  assert.deepEqual(rec.ignoredKeys, []);
  assert.equal(rec.map.get(rt.BUNDLE_HINT_KEY), 'com.example/tagdrop');
});
