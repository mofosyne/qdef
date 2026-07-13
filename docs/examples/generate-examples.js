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

console.log('$ node scripts/gen-type-id.js com.example.myapp/route');
console.log(run('node gen-type-id.js com.example.myapp/route'));
console.log();

console.log('$ node scripts/validate-type-id.js com.example.myapp/route "h\'216e6add\'"');
console.log(run('node validate-type-id.js com.example.myapp/route "h\'216e6add\'"'));
console.log();

console.log('$ node scripts/gen-type-id.js --namespace --width 4 com.example/myapp-paper');
console.log(run('node gen-type-id.js --namespace --width 4 com.example/myapp-paper'));
console.log();

console.log('$ node scripts/validate-type-id.js --namespace com.example/myapp-paper "h\'3cf2360e\'"');
console.log(run('node validate-type-id.js --namespace com.example/myapp-paper "h\'3cf2360e\'"'));
console.log();

console.log('=== CBOR Wire Encoding ===\n');
console.log('Byte string h\'216e6add\' encodes as: 44 21 6e 6a dd');
console.log('  44 = CBOR major type 2 (byte string), length 4');
console.log('  21 6e 6a dd = the 4 bytes of data');
console.log();
console.log('Byte string h\'3cf2360e\' encodes as: 44 3c f2 36 0e');
console.log('  44 = CBOR major type 2 (byte string), length 4');
console.log('  3c f2 36 0e = the 4 bytes of data');
