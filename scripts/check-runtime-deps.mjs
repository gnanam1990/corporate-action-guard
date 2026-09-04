#!/usr/bin/env node
/**
 * A package imported by production source must be a production dependency.
 *
 * `pg` was imported by `apps/api/src/index.ts` and declared in `devDependencies`. Every
 * test passed, because tests install everything. A production install omitted it and the
 * container died at startup with ERR_MODULE_NOT_FOUND — and that would have happened in
 * any deployment, not just a container.
 *
 * The class of bug is invisible to a test suite by construction, so it needs a check of
 * its own.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKSPACES = ['apps', 'packages'];

/** Source that ships. Test files legitimately use dev dependencies. */
const isProductionSource = (file) =>
  !/[.](test|spec)[.]tsx?$/.test(file) && !file.includes(`${path.sep}test${path.sep}`);

const IMPORT_RE =
  /(?:import|export)[\s\S]{0,200}?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Bare package name from a specifier: `@scope/name/sub` -> `@scope/name`. */
const packageName = (spec) =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];

/**
 * Is this specifier a real package?
 *
 * Excludes relative paths, node: builtins, subpath imports, and tsconfig path aliases
 * (`@/components` is a compile-time alias, not something npm installs). Also requires the
 * result to LOOK like a package name, because the import regex can match inside a string
 * literal in a large object — an ABI definition produced one such false positive.
 */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

const isExternal = (spec) => {
  if (spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('#')) return false;
  // `@/` is the tsconfig alias for the app's own src directory.
  if (spec.startsWith('@/')) return false;
  return PACKAGE_NAME_RE.test(packageName(spec));
};

const BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'events',
  'fs',
  'http',
  'https',
  'net',
  'os',
  'path',
  'process',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'url',
  'util',
  'worker_threads',
  'zlib',
]);

function sourceFiles(dir) {
  const out = [];
  const skip = new Set(['node_modules', 'dist', '.next', 'coverage', 'out', 'test']);
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts)$/.test(e.name) && isProductionSource(p)) out.push(p);
    }
  })(dir);
  return out;
}

const problems = [];

for (const base of WORKSPACES) {
  const abs = path.join(ROOT, base);
  if (!fs.existsSync(abs)) continue;

  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(abs, entry.name);
    const manifestPath = path.join(dir, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const deps = new Set(Object.keys(manifest.dependencies ?? {}));
    const devDeps = new Set(Object.keys(manifest.devDependencies ?? {}));
    const peers = new Set(Object.keys(manifest.peerDependencies ?? {}));

    for (const file of sourceFiles(path.join(dir, 'src'))) {
      const src = fs.readFileSync(file, 'utf8');
      for (const match of src.matchAll(IMPORT_RE)) {
        const spec = match[1] ?? match[2] ?? match[3];
        if (spec === undefined || !isExternal(spec)) continue;
        const name = packageName(spec);
        if (BUILTINS.has(name)) continue;
        if (deps.has(name) || peers.has(name)) continue;

        if (devDeps.has(name)) {
          problems.push(
            `${path.relative(ROOT, file)}: imports "${name}", which ${manifest.name} declares as a devDependency. ` +
              'A production install will omit it.',
          );
        } else {
          problems.push(
            `${path.relative(ROOT, file)}: imports "${name}", which ${manifest.name} does not declare at all.`,
          );
        }
      }
    }
  }
}

const unique = [...new Set(problems)];
if (unique.length > 0) {
  console.error('Runtime imports that a production install would not provide:\n');
  for (const p of unique) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('Runtime dependencies: OK (every production import is a production dependency).');
