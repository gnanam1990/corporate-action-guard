#!/usr/bin/env node
/**
 * Architecture dependency rule (ADR 0001 / docs/architecture/component-map.md).
 *
 * A workspace package may only import from a STRICTLY lower layer, and nothing may
 * import an app. This is checked against declared package.json dependencies and
 * against actual import specifiers in source, so a rule cannot be bypassed by
 * importing a path directly.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Layer number per workspace package. Lower may not import higher or equal. */
const LAYER = {
  '@cag/config': 0,
  '@cag/domain': 1,
  '@cag/db': 2,
  '@cag/observability': 2,
  '@cag/xstocks-client': 3,
  '@cag/xlayer-reader': 3,
  '@cag/receipts': 3,
  '@cag/reconciler': 4,
  '@cag/api': 5,
  '@cag/worker': 5,
  '@cag/web': 6,
  '@cag/sdk': 6,
};

/** Packages that must not import ANY other workspace package. */
const ISOLATED = new Set(['@cag/domain', '@cag/config', '@cag/sdk', '@cag/web']);

const WORKSPACE_DIRS = ['apps', 'packages'];
const violations = [];

function pkgDirs() {
  const out = [];
  for (const base of WORKSPACE_DIRS) {
    const abs = path.join(ROOT, base);
    if (!fs.existsSync(abs)) continue;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(abs, e.name, 'package.json'))) {
        out.push(path.join(abs, e.name));
      }
    }
  }
  return out;
}

function sourceFiles(dir) {
  const out = [];
  const skip = new Set(['node_modules', 'dist', '.next', 'coverage', 'out']);
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(e.name)) out.push(p);
    }
  })(dir);
  return out;
}

const IMPORT_RE =
  /(?:import|export)[\s\S]{0,200}?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function check(fromPkg, spec, where) {
  if (!spec.startsWith('@cag/')) return;
  const target = spec.split('/').slice(0, 2).join('/');
  if (!(target in LAYER)) {
    violations.push(`${where}: imports unknown workspace package "${target}"`);
    return;
  }
  if (target === fromPkg) return;

  if (LAYER[target] >= 5) {
    violations.push(`${where}: ${fromPkg} imports app "${target}" — nothing may import an app`);
    return;
  }
  if (ISOLATED.has(fromPkg)) {
    violations.push(
      `${where}: ${fromPkg} must not import any workspace package (imports "${target}")`,
    );
    return;
  }
  if (LAYER[target] >= LAYER[fromPkg]) {
    violations.push(
      `${where}: ${fromPkg} (L${LAYER[fromPkg]}) imports "${target}" (L${LAYER[target]}) — must be a strictly lower layer`,
    );
  }
}

for (const dir of pkgDirs()) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const name = pkg.name;
  if (!(name in LAYER)) {
    violations.push(`${path.relative(ROOT, dir)}: package "${name}" has no assigned layer`);
    continue;
  }

  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      check(name, dep, `${path.relative(ROOT, dir)}/package.json (${field})`);
    }
  }

  for (const file of sourceFiles(dir)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec) check(name, spec, path.relative(ROOT, file));
    }
  }
}

if (violations.length > 0) {
  console.error('Architecture dependency rule violated:\n');
  for (const v of violations) console.error(`  - ${v}`);
  console.error(`\n${violations.length} violation(s). See docs/architecture/component-map.md.`);
  process.exit(1);
}
console.log(`Architecture dependency rule: OK (${pkgDirs().length} workspace packages checked).`);
