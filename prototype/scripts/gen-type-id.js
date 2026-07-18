#!/usr/bin/env node
'use strict';
// Generate a hash-derived Namespace ID from a qualified name, per spec
// §3.5's pinned algorithm:
//
//   digest = SHA-256(UTF-8(name))
//   N      = developer-chosen byte length (minimum 2, recommended 4+)
//   ID     = digest[0..N] as a definite-length CBOR byte string
//
// Usage:
//   node scripts/gen-type-id.js <name>
//   node scripts/gen-type-id.js --width 4|8 <name>
//
// Names SHOULD be reverse-domain qualified (e.g. "com.example.myapp-paper")
// for collision-safety — see spec §3.5 and DESIGN.md's "Pinning the
// algorithm" section. Unqualified names are accepted with a warning.
//
// Namespace-only: decentralized (byte string) Record Type IDs were
// retired entirely (spec §3.1) — a namespace-scoped odd uint Type ID
// gives every Record Type inside a declared namespace the identical
// zero-coordination collision safety at a fraction of the per-ID cost,
// so there is no longer a "Record Type ID" mode for this tool to offer.
// This algorithm's only remaining direct use is deriving a Namespace ID
// (the value goes into the container discriminator, spec §3.5).
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
  console.error(`Usage: node scripts/gen-type-id.js [--width 2|4|8] <name>

Derive a hash-based Namespace ID (spec §3.5) from a name.

Arguments:
  name            Reverse-domain qualified name (e.g. "com.example/myapp-paper")
  --width N       Output width in bytes (minimum 2). Without this flag, 4 and 8 are shown.

Algorithm (spec §3.5):
  SHA-256(UTF-8(name)), truncated to N bytes as a CBOR byte string.
  N is developer-chosen: 4+ bytes recommended (self-certify freely at
  this length or longer; shorter is reserved, not self-allocatable --
  see spec §3.5's byte-length guidance).

Examples:
  node scripts/gen-type-id.js com.example/myapp-paper
  node scripts/gen-type-id.js --width 8 com.example/myapp-paper`);
}

const args = process.argv.slice(2);
let forcedWidth = null;

// Parse flags
const flagIdx = { width: args.indexOf('--width') };

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
  console.error('  Names SHOULD be qualified (e.g. "com.example/myapp-paper")');
  console.error('  for collision-safety. See spec §3.5.');
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
    console.log(`\nNote: ${forcedWidth}-byte namespace IDs are reserved, not self-allocatable`);
    console.log('  (spec §3.5). Use 4+ bytes to self-certify with no coordination.');
  }
} else {
  const full = formatResult(deriveHashId(name, 32));
  const narrow = formatResult(deriveHashId(name, 4));
  const wide = formatResult(deriveHashId(name, 8));
  console.log(`Name:        ${name}`);
  console.log(`Derivation:  SHA-256(UTF-8("${name}"))\n`);
  console.log(`  Full SHA-256:`);
  console.log(`    h'${full.hex}'\n`);
  console.log(`  4-byte (recommended minimum, self-certify freely):`);
  console.log(`    Value (hex): h'${narrow.hex}'`);
  console.log(`\n  8-byte (maximum safety):`);
  console.log(`    Value (hex): h'${wide.hex}'`);
}

console.log('\nUsage in wire format: the container discriminator (spec §3.5),');
console.log('the mandatory CBOR item right after magic. Cheapest form is the');
console.log('bare byte string itself:');
console.log('  h\'<value above>\'                          // namespace, no hint');
console.log('\nTo also carry a recoverable Hint name, use the map form:');
console.log('  { 1: h\'<value above>\', 3: "<name>" }      // map form');
