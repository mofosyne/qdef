'use strict';
// TagDrop asked directly whether a Type 0 namespace declaration needs to
// repeat on every physical code of a multi-code Split group, or can appear
// once. Answered by tracing the actual mechanics: each code is parsed as
// its own independent container with no cross-code state (DESIGN.md's
// "Type ID inheritance"/"Reference tags" entries already established this
// for a different reason), and `parity_scheme` recovers missing *fragment
// bytes*, never a missing *sibling Record* -- so a namespace declared on
// only one code is a single point of failure `resolveStack` cannot recover
// from, unlike the Split-protected content itself.
//
// `resolveStack` (wrappers.js) was extended to look for a Type 0 sibling
// on each code, require every code that declares one to agree, and apply
// the agreed namespace to whatever Record the stack ultimately resolves to
// -- including one only reachable after full Split reassembly, closing the
// gap this exact question exposed (the resolver previously only ever
// looked at `records[0]`, with no way to route past a Type 0 sibling at
// all).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const core = require('../src/core');
const wrappers = require('../src/wrappers');
const header = require('../src/header');

const NAMESPACE = 12271745624591856273n;
const NAMESPACE_SCOPED_TYPE = 32769; // odd uint -- requires a declared namespace
const KNOWN_KEYS = new Map([
  [wrappers.SPLIT_TYPE, wrappers.SPLIT_KNOWN_KEYS],
  [NAMESPACE_SCOPED_TYPE, new Set([0])],
]);

function buildCodes({ repeatHeaderOnEveryCode }) {
  const innerBytes = core.encodeRecordBytes({
    typeIds: [NAMESPACE_SCOPED_TYPE],
    fields: new Map([[0, 'namespace-scoped payload']]),
  });
  const fragmentRecords = wrappers.splitEncode(innerBytes, {
    count: 3,
    parityScheme: wrappers.PARITY_SCHEME_XOR,
  });

  return fragmentRecords.map((fragRec, i) => {
    const records = [fragRec];
    if (repeatHeaderOnEveryCode || i === 0) {
      records.unshift({
        typeIds: [header.HEADER_TYPE],
        fields: new Map([[header.HEADER_NAMESPACE_KEY, NAMESPACE]]),
      });
    }
    return core.encodeContainer(records);
  });
}

test('a namespace repeated on every code resolves correctly after full Split reassembly', () => {
  const codes = buildCodes({ repeatHeaderOnEveryCode: true });
  const terminal = wrappers.resolveStack(codes, {}, KNOWN_KEYS);

  assert.equal(terminal.typeId, NAMESPACE_SCOPED_TYPE);
  assert.equal(terminal.namespace, NAMESPACE);
  assert.equal(terminal.map.get(0), 'namespace-scoped payload');
});

test('the repeated namespace survives losing any one code, same as the data it describes', () => {
  const codes = buildCodes({ repeatHeaderOnEveryCode: true });
  // Drop one of the 4 codes (3 data + 1 parity) -- XOR parity recovers the
  // missing fragment bytes, and since the header was repeated on every
  // code, its copy survives on whichever 3 codes remain.
  const droppedOneCode = [codes[0], codes[1], codes[3]];

  const terminal = wrappers.resolveStack(droppedOneCode, {}, KNOWN_KEYS);
  assert.equal(terminal.namespace, NAMESPACE);
  assert.equal(terminal.map.get(0), 'namespace-scoped payload');
});

test('FINDING: a namespace declared on only one code is a single point of failure the data itself is NOT -- losing that one code loses the namespace even though parity fully recovers the content', () => {
  const codes = buildCodes({ repeatHeaderOnEveryCode: false }); // header only on codes[0]
  // Drop exactly the code carrying the only Type 0 header. Parity still
  // recovers the missing fragment's bytes fine -- the content is intact.
  const droppedTheHeaderCode = [codes[1], codes[2], codes[3]];

  assert.throws(
    () => wrappers.resolveStack(droppedTheHeaderCode, {}, KNOWN_KEYS),
    /odd uint Type ID .* requires a declared namespace/,
  );

  // Confirming it's really the namespace that's missing, not the data:
  // keeping the header's code alongside the same dropped fragment resolves
  // fine, since the header (and enough fragments) are both present.
  const keepingTheHeaderCode = [codes[0], codes[1], codes[3]];
  const terminal = wrappers.resolveStack(keepingTheHeaderCode, {}, KNOWN_KEYS);
  assert.equal(terminal.namespace, NAMESPACE);
});

test('codes disagreeing on the declared namespace is rejected, not silently resolved one way or the other', () => {
  const innerBytes = core.encodeRecordBytes({
    typeIds: [NAMESPACE_SCOPED_TYPE],
    fields: new Map([[0, 'payload']]),
  });
  const fragmentRecords = wrappers.splitEncode(innerBytes, { count: 2 });
  const codes = [
    core.encodeContainer([
      { typeIds: [header.HEADER_TYPE], fields: new Map([[header.HEADER_NAMESPACE_KEY, 111n]]) },
      fragmentRecords[0],
    ]),
    core.encodeContainer([
      { typeIds: [header.HEADER_TYPE], fields: new Map([[header.HEADER_NAMESPACE_KEY, 222n]]) },
      fragmentRecords[1],
    ]),
  ];

  assert.throws(
    () => wrappers.resolveStack(codes, {}, KNOWN_KEYS),
    /inconsistent namespace/,
  );
});

test('a namespace-scoped Type ID with no Type 0 header anywhere in the group still aborts, same as the single-code case', () => {
  const innerBytes = core.encodeRecordBytes({
    typeIds: [NAMESPACE_SCOPED_TYPE],
    fields: new Map([[0, 'payload']]),
  });
  const fragmentRecords = wrappers.splitEncode(innerBytes, { count: 2 });
  const codes = fragmentRecords.map((f) => core.encodeContainer([f]));

  assert.throws(
    () => wrappers.resolveStack(codes, {}, KNOWN_KEYS),
    /odd uint Type ID .* requires a declared namespace/,
  );
});
