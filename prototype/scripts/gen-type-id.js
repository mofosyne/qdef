#!/usr/bin/env node
'use strict';
// Generate a hash-derived decentralized Record Type ID (or Namespace ID)
// from a qualified name, per spec §3.1's pinned algorithm:
//
//   digest = SHA-256(UTF-8(name))
//   N      = developer-chosen byte length (minimum 2, recommended 4+)
//   ID     = digest[0..N] as a definite-length CBOR byte string
//
// Usage:
//   node scripts/gen-type-id.js <name>
//   node scripts/gen-type-id.js --namespace <name>
//   node scripts/gen-type-id.js --width 2|4|8 <name>
//
// Names SHOULD be reverse-domain qualified (e.g. "com.example.myapp/route")
// for collision-safety — see spec §3.1 and DESIGN.md's "Pinning the algorithm"
// section. Unqualified names are accepted with a warning.
//
// Without --namespace: derives a Record Type ID.
// With --namespace:    derives a Namespace ID (same algorithm, different
//   intended use — the value goes into Type 0's key 3, not a Record's key 0).
//
// --width lets you pick the output byte width. Without it, 4 and 8 are shown.

const crypto = require('crypto');

const MIN_BYTE_LENGTH = 2;

function deriveHashId(name, byteWidth) {
  if (byteWidth < MIN_BYTE_LENGTH) {
    throw new Error(`byteWidth must be >= ${MIN_BYTE_LENGTH}, got ${byteWidth}`);
  }
  const digest = crypto.createHash('sha256').update(name, 'utf8').digest();
  return Buffer.from(digest.subarray(0, byteWidth));
}

function formatResult(buf) {
  const hex = buf.toString('hex');
  return { hex, length: buf.length };
}

function usage() {
  console.error(`Usage: node scripts/gen-type-id.js [--namespace] [--width 2|4|8] <name>

Derive a hash-based decentralized Record Type ID or Namespace ID from a name.

Arguments:
  name            Reverse-domain qualified name (e.g. "com.example.myapp/route")
  --namespace     Derive a Namespace ID instead of a Record Type ID
  --width N       Output width in bytes (minimum 2). Without this flag, 4 and 8 are shown.

Algorithm (spec §3.1):
  SHA-256(UTF-8(name)), truncated to N bytes as a CBOR byte string.
  N is developer-chosen: 2 for namespace-scoped, 4+ for global use.

Examples:
  node scripts/gen-type-id.js com.example.myapp/route
  node scripts/gen-type-id.js --namespace com.example/myapp-paper
  node scripts/gen-type-id.js --width 8 com.example.myapp/route`);
}

const args = process.argv.slice(2);
let asNamespace = false;
let forcedWidth = null;

// Parse flags
const flagIdx = {
  namespace: args.indexOf('--namespace'),
  width: args.indexOf('--width'),
};

if (flagIdx.namespace !== -1) {
  asNamespace = true;
  args.splice(flagIdx.namespace, 1);
}

if (flagIdx.width !== -1) {
  const wIdx = args.indexOf('--width');
  forcedWidth = parseInt(args[wIdx + 1], 10);
  if (isNaN(forcedWidth) || forcedWidth < MIN_BYTE_LENGTH) {
    console.error(`Error: --width must be >= ${MIN_BYTE_LENGTH}.`);
    process.exit(1);
  }
  args.splice(wIdx, 2);
}

if (args.includes('--help') || args.includes('-h') || args.length !== 1) {
  usage();
  process.exit(args.includes('--help') || args.includes('-h') ? 0 : 1);
}

const name = args[0];

if (!name || name.length === 0) {
  console.error('Error: name must not be empty.');
  process.exit(1);
}

// Warn on unqualified names (no dot or slash — likely not reverse-domain).
if (!name.includes('.') && !name.includes('/')) {
  console.error(`Warning: "${name}" does not look reverse-domain qualified.`);
  console.error('  Names SHOULD be qualified (e.g. "com.example.myapp/route")');
  console.error('  for collision-safety. See spec §3.1.');
  console.error('');
}

if (forcedWidth) {
  const full = formatResult(deriveHashId(name, 32));
  const result = formatResult(deriveHashId(name, forcedWidth));
  console.log(`Name:        ${name}`);
  console.log(`Derivation:  SHA-256(UTF-8("${name}")) → first ${forcedWidth} bytes\n`);
  console.log(`  Full SHA-256:`);
  console.log(`    h'${full.hex}'`);
  console.log(`\n  Truncated to ${forcedWidth} bytes:`);
  console.log(`    Value (hex): h'${result.hex}'`);
  console.log(`    CBOR wire:   ${(Buffer.from([0x40 + forcedWidth]).toString('hex') + result.hex)}`);
  if (forcedWidth < 4) {
    console.log(`\nNote: ${forcedWidth}-byte IDs are recommended for namespace-scoped use only.`);
    console.log('  Use 4+ bytes for global (unnamespaced) use.');
  }
} else {
  const full = formatResult(deriveHashId(name, 32));
  const narrow = formatResult(deriveHashId(name, 4));
  const wide = formatResult(deriveHashId(name, 8));
  console.log(`Name:        ${name}`);
  console.log(`Derivation:  SHA-256(UTF-8("${name}"))\n`);
  console.log(`  Full SHA-256:`);
  console.log(`    h'${full.hex}'\n`);
  console.log(`  4-byte (recommended minimum for global use):`);
  console.log(`    Value (hex): h'${narrow.hex}'`);
  console.log(`\n  8-byte (maximum safety):`);
  console.log(`    Value (hex): h'${wide.hex}'`);
}

if (asNamespace) {
  console.log('\nUsage in wire format: first Record in Sequence is Type 0, with');
  console.log('  key 3 (Namespace ID) = h\'<value above>\' (byte string)');
  console.log(`  key 5 (name)         = "${name}"`);
}
