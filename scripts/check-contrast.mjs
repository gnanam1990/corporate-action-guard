#!/usr/bin/env node
/**
 * WCAG 2.2 contrast verification for the design tokens.
 *
 * Contrast is asserted, not eyeballed. Every token pair that renders text or a meaningful
 * non-text boundary is checked against the relevant threshold, so a palette change that
 * quietly drops a status below readable fails the build.
 *
 * Thresholds: 4.5:1 for normal text, 3:1 for large text and meaningful non-text UI.
 */
import fs from 'node:fs';
import path from 'node:path';

const TOKENS = path.resolve(import.meta.dirname, '../apps/web/src/styles/tokens.css');

function parseTokens(css) {
  const map = new Map();
  for (const match of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    map.set(match[1], match[2]);
  }
  return map;
}

function toRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Relative luminance, per WCAG 2.x. */
function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const tokens = parseTokens(fs.readFileSync(TOKENS, 'utf8'));
const get = (name) => {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`token --${name} not found`);
  return value;
};

/** [foreground, background, minimum, description] */
const CHECKS = [
  ['text-primary', 'surface-base', 4.5, 'body text on the base surface'],
  ['text-primary', 'surface-raised', 4.5, 'body text on a raised surface'],
  ['text-primary', 'surface-muted', 4.5, 'body text on a muted surface'],
  ['text-secondary', 'surface-base', 4.5, 'secondary text on the base surface'],
  ['text-secondary', 'surface-raised', 4.5, 'secondary text on a raised surface'],
  ['text-muted', 'surface-base', 4.5, 'muted text on the base surface'],
  ['text-muted', 'surface-raised', 4.5, 'muted text on a raised surface'],
  ['text-muted', 'surface-inset', 4.5, 'muted text in the footer and nav'],

  // Status text sits on its own tinted background.
  ['status-verified-fg', 'status-verified-bg', 4.5, 'verified badge text'],
  ['status-pending-fg', 'status-pending-bg', 4.5, 'pending badge text'],
  ['status-blocked-fg', 'status-blocked-bg', 4.5, 'blocked badge text'],
  ['status-chain-fg', 'status-chain-bg', 4.5, 'chain badge text'],
  ['status-unknown-fg', 'status-unknown-bg', 4.5, 'unknown badge text'],

  // Status text also appears directly on surfaces (links, inline labels).
  ['status-chain-fg', 'surface-base', 4.5, 'address links on the base surface'],
  ['status-blocked-fg', 'surface-base', 4.5, 'blocked text on the base surface'],

  // Meaningful non-text boundaries.
  ['border-default', 'surface-base', 3, 'default border against the base surface'],
  ['status-verified-border', 'status-verified-bg', 3, 'verified badge border'],
  ['status-blocked-border', 'status-blocked-bg', 3, 'blocked badge border'],
  ['status-pending-border', 'status-pending-bg', 3, 'pending badge border'],
  ['status-chain-border', 'status-chain-bg', 3, 'chain badge border'],
  ['status-unknown-border', 'status-unknown-bg', 3, 'unknown badge border'],
  ['border-subtle', 'surface-base', 1.5, 'subtle divider (decorative, low bar)'],
  ['border-strong', 'surface-raised', 3, 'strong border on a raised surface'],
  ['action-primary', 'surface-base', 3, 'primary action against the base surface'],
  ['focus-ring', 'surface-base', 3, 'focus ring against the base surface'],
  ['focus-ring', 'surface-raised', 3, 'focus ring against a raised surface'],
  ['focus-ring', 'surface-muted', 3, 'focus ring against a muted surface'],

  ['action-primary-fg', 'action-primary', 4.5, 'text on a primary button'],
];

const failures = [];
const results = [];

for (const [fg, bg, minimum, description] of CHECKS) {
  const value = ratio(get(fg), get(bg));
  const ok = value >= minimum;
  results.push(`${ok ? 'OK  ' : 'FAIL'} ${value.toFixed(2)}:1 (min ${minimum}) — ${description}`);
  if (!ok)
    failures.push(`${description}: ${value.toFixed(2)}:1, needs ${minimum}:1 (--${fg} on --${bg})`);
}

for (const line of results) console.log(line);

if (failures.length > 0) {
  console.error(`\n${failures.length} contrast failure(s):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nContrast: OK (${CHECKS.length} pairs checked).`);
