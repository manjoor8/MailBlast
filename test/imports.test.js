/**
 * Static import audit.
 *
 * Parses every ESM file under public/ and server/ and checks that each named
 * import actually exists as an export in the target module. This catches the
 * classic frontend failure mode — a typo'd or missing export that only shows up
 * as a blank screen at runtime — without needing a browser.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = [...walk(path.join(ROOT, 'public')), ...walk(path.join(ROOT, 'server'))];

const IMPORT_RE = /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+[\w$]+|([\w$]+))\s+from\s+['"]([^'"]+)['"]/g;
const EXPORT_RE = /export\s+(?:async\s+)?(?:function\s+([\w$]+)|class\s+([\w$]+)|(?:const|let|var)\s+([\w$]+)|default\b|\{([^}]*)\})/g;

/** Collect the exported names of a module (approximate but reliable for this codebase). */
function exportedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(EXPORT_RE)) {
    if (match[1]) names.add(match[1]);
    if (match[2]) names.add(match[2]);
    if (match[3]) names.add(match[3]);
    if (match[4]) {
      for (const part of match[4].split(',')) {
        const piece = part.trim();
        if (!piece) continue;
        const alias = piece.split(/\s+as\s+/);
        names.add((alias[1] ?? alias[0]).trim());
      }
    }
  }
  if (/export\s+default\b/.test(source)) names.add('default');
  return names;
}

const moduleCache = new Map();
function loadModule(file) {
  if (!moduleCache.has(file)) {
    moduleCache.set(file, exportedNames(fs.readFileSync(file, 'utf8')));
  }
  return moduleCache.get(file);
}

const problems = [];
let checked = 0;
let importCount = 0;

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(IMPORT_RE)) {
    const [, defaultName, named, bareName, spec] = match;
    if (!spec.startsWith('.')) continue; // node_modules / node: builtins

    const target = path.resolve(path.dirname(file), spec);
    if (!fs.existsSync(target)) {
      problems.push(`${path.relative(ROOT, file)} imports "${spec}" which does not exist`);
      continue;
    }

    importCount += 1;
    const exports = loadModule(target);
    const requested = [];

    if (defaultName) requested.push('default');
    if (bareName) requested.push('default');
    if (named) {
      for (const part of named.split(',')) {
        const piece = part.trim();
        if (!piece) continue;
        requested.push(piece.split(/\s+as\s+/)[0].trim());
      }
    }

    for (const name of requested) {
      if (!exports.has(name)) {
        problems.push(
          `${path.relative(ROOT, file)} imports { ${name} } from "${spec}", but that module exports only: ${[...exports].sort().join(', ')}`,
        );
      }
    }
  }
  checked += 1;
}

console.log(`\nImport audit — ${checked} modules, ${importCount} relative imports\n`);

if (problems.length) {
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(`\n${problems.length} problem(s) found.\n`);
  process.exit(1);
}

console.log('  ✓ every relative import resolves to a real export\n');
