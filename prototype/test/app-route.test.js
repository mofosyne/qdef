'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const wrappers = require('../src/wrappers');

// ---------------------------------------------------------------------
// §4.4's App Route (Type 12): a plain standard record type, not a wrapper.
// ---------------------------------------------------------------------

test('App Route with a domain and a human-readable label round-trips', () => {
  const container = core.encodeContainer([
    {
      typeIds: [wrappers.APP_ROUTE_TYPE],
      fields: new Map([
        [0, 'example.com'],
        [1, 'Open in Example App'],
      ]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], wrappers.APP_ROUTE_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
  assert.equal(rec.map.get(0), 'example.com');
  assert.equal(rec.map.get(1), 'Open in Example App');
});

test('the label is optional — a domain alone is a complete App Route Record', () => {
  const container = core.encodeContainer([
    { typeIds: [wrappers.APP_ROUTE_TYPE], fields: new Map([[0, 'example.com']]) },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], wrappers.APP_ROUTE_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
  assert.equal(rec.map.get(0), 'example.com');
  assert.equal(rec.map.has(1), false);
});

test('App Route is not positionally special — routes the same whether first or last in the Sequence', () => {
  const routeFirst = core.encodeContainer([
    { typeIds: [wrappers.APP_ROUTE_TYPE], fields: new Map([[0, 'example.com']]) },
    { typeIds: [100], fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) },
  ]);
  const routeLast = core.encodeContainer([
    { typeIds: [100], fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) },
    { typeIds: [wrappers.APP_ROUTE_TYPE], fields: new Map([[0, 'example.com']]) },
  ]);

  for (const container of [routeFirst, routeLast]) {
    const { records } = core.decodeContainer(container);
    const route = records.find((r) => r.typeId === wrappers.APP_ROUTE_TYPE);
    const checked = core.applyCriticality(route, wrappers.APP_ROUTE_KNOWN_KEYS);
    assert.equal(checked.aborted, false);
    assert.equal(checked.map.get(0), 'example.com');
  }
});

test('an application with no interest in App Route skips the whole Record cleanly by Type ID alone', () => {
  const container = core.encodeContainer([
    { typeIds: [wrappers.APP_ROUTE_TYPE], fields: new Map([[0, 'example.com']]) },
    { typeIds: [100], fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) },
  ]);

  const { records } = core.decodeContainer(container);
  const KNOWN_TYPES = new Map([[100, new Set([0, 1, 2, 4])]]);
  const handled = records
    .filter((r) => !r.ignored && KNOWN_TYPES.has(r.typeId))
    .map((r) => core.applyCriticality(r, KNOWN_TYPES.get(r.typeId)));

  assert.equal(records.length, 2);
  assert.equal(handled.length, 1);
  assert.equal(handled[0].typeId, 100);
});

test('App Route decentralized form (private-use uint + Hint name) round-trips', () => {
  const container = core.encodeContainer([
    {
      typeIds: [wrappers.APP_ROUTE_TYPE],
      fields: new Map([
        [0, 12271745624591856273n],
        [1, 'com.example/tagdrop-paper'],
      ]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], wrappers.APP_ROUTE_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
  assert.equal(rec.map.get(0), 12271745624591856273n);
  assert.equal(rec.map.get(1), 'com.example/tagdrop-paper');
});

test('a scanner that only understands the domain form still skips a decentralized-form Record cleanly by Type ID alone', () => {
  const container = core.encodeContainer([
    {
      typeIds: [wrappers.APP_ROUTE_TYPE],
      fields: new Map([[0, 12271745624591856273n], [1, 'com.example/tagdrop-paper']]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], wrappers.APP_ROUTE_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
});

test('encoding the same App Route fields twice produces identical bytes', () => {
  const fields = new Map([[0, 'example.com'], [1, 'Open in Example App']]);
  const a = core.encodeRecordBytes({ typeIds: [wrappers.APP_ROUTE_TYPE], fields });
  const b = core.encodeRecordBytes({ typeIds: [wrappers.APP_ROUTE_TYPE], fields: new Map(fields) });
  assert.deepEqual(a, b);
});
