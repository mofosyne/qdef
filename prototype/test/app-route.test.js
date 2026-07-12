'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const wrappers = require('../src/wrappers');

// ---------------------------------------------------------------------
// §4.4's App Route (Type 7): a plain stdlib Record, not a wrapper, for
// letting a generic scanner offer to launch a specific handling
// application (GitHub issue #10) — comparable to NFC's Android
// Application Record. Key 2 is a domain, verified the way Android App
// Links / iOS Universal Links already are; QDEF never touches how that
// verification or dispatch actually happens, only carries the identifier.
// ---------------------------------------------------------------------

test('App Route with a domain and a human-readable label round-trips', () => {
  const container = core.encodeContainer([
    {
      typeId: wrappers.APP_ROUTE_TYPE,
      fields: new Map([
        [2, 'example.com'],
        [3, 'Open in Example App'],
      ]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], wrappers.APP_ROUTE_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
  assert.equal(rec.map.get(2), 'example.com');
  assert.equal(rec.map.get(3), 'Open in Example App');
});

test('the label is optional — a domain alone is a complete App Route Record', () => {
  const container = core.encodeContainer([
    { typeId: wrappers.APP_ROUTE_TYPE, fields: new Map([[2, 'example.com']]) },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], wrappers.APP_ROUTE_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
  assert.equal(rec.map.get(2), 'example.com');
  assert.equal(rec.map.has(3), false);
});

test('App Route is not positionally special — routes the same whether first or last in the Sequence', () => {
  const routeFirst = core.encodeContainer([
    { typeId: wrappers.APP_ROUTE_TYPE, fields: new Map([[2, 'example.com']]) },
    { typeId: 100, fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2]]) },
  ]);
  const routeLast = core.encodeContainer([
    { typeId: 100, fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2]]) },
    { typeId: wrappers.APP_ROUTE_TYPE, fields: new Map([[2, 'example.com']]) },
  ]);

  for (const container of [routeFirst, routeLast]) {
    const { records } = core.decodeContainer(container);
    const route = records.find((r) => r.typeId === wrappers.APP_ROUTE_TYPE);
    const checked = core.applyCriticality(route, wrappers.APP_ROUTE_KNOWN_KEYS);
    assert.equal(checked.aborted, false);
    assert.equal(checked.map.get(2), 'example.com');
  }
});

test('an application with no interest in App Route skips the whole Record cleanly by Type ID alone', () => {
  const container = core.encodeContainer([
    { typeId: wrappers.APP_ROUTE_TYPE, fields: new Map([[2, 'example.com']]) },
    { typeId: 100, fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2]]) },
  ]);

  const { records } = core.decodeContainer(container);
  const KNOWN_TYPES = new Map([[100, new Set([0, 2, 3, 4, 6])]]);
  const handled = records
    .filter((r) => !r.aborted && KNOWN_TYPES.has(r.typeId))
    .map((r) => core.applyCriticality(r, KNOWN_TYPES.get(r.typeId)));

  assert.equal(records.length, 2);
  assert.equal(handled.length, 1);
  assert.equal(handled[0].typeId, 100);
});

test('encoding the same App Route fields twice (simulating repetition across a multi-code group) produces identical bytes', () => {
  // §4.4's etiquette: repeat verbatim on every code in a multi-code group,
  // so a scanner can decide from any single scanned code. That guarantee
  // depends on §3.4's canonical encoding — two independent encode calls
  // for the same logical fields must agree byte-for-byte, not just
  // "look the same" when inspected.
  const fields = new Map([[2, 'example.com'], [3, 'Open in Example App']]);
  const a = core.encodeRecordBytes({ typeId: wrappers.APP_ROUTE_TYPE, fields });
  const b = core.encodeRecordBytes({ typeId: wrappers.APP_ROUTE_TYPE, fields: new Map(fields) });
  assert.deepEqual(a, b);
});
