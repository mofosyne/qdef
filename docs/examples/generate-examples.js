#!/usr/bin/env node
'use strict';
// Generate all examples for docs/examples/registry-walkthrough.md
// Run: node docs/examples/generate-examples.js

const { execSync } = require('child_process');
const path = require('path');

const scriptDir = __dirname;
const scriptsDir = path.join(scriptDir, '..', '..', 'prototype', 'scripts');

function run(cmd) {
  return execSync(cmd, { cwd: scriptsDir, encoding: 'utf8' }).trim();
}

console.log('=== Registry Example Output ===\n');

console.log('$ node scripts/gen-type-id.js com.example/myapp-paper');
console.log(run('node gen-type-id.js com.example/myapp-paper'));
console.log();

console.log('$ node scripts/validate-type-id.js com.example/myapp-paper "h\'3cf2360e\'"');
console.log(run('node validate-type-id.js com.example/myapp-paper "h\'3cf2360e\'"'));
console.log();

console.log('=== CBOR Wire Encoding ===\n');
console.log('Byte string h\'3cf2360e\' encodes as: 44 3c f2 36 0e');
console.log('  44 = CBOR major type 2 (byte string), length 4');
console.log('  3c f2 36 0e = the 4 bytes of data');
console.log();
console.log('uint(105) (a common-vocabulary global Type ID) encodes as: 18 69');
console.log('  18 = CBOR major type 0 (unsigned int), 1-byte argument follows');
console.log('  69 = 105');
