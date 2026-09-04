#!/usr/bin/env node
/**
 * Generate docs/architecture-diagram.svg.
 *
 * Hand-written SVG rather than a rendered image: it is editable, diffable in review, and
 * carries a real text alternative. A PNG exported from a drawing tool goes stale silently
 * and is unreadable to a screen reader.
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '../docs/architecture-diagram.svg');

const box = (x, y, w, h, title, subtitle, fill, stroke) => `
  <g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
    <text x="${x + w / 2}" y="${y + 22}" text-anchor="middle" class="t">${title}</text>
    ${subtitle ? `<text x="${x + w / 2}" y="${y + 40}" text-anchor="middle" class="s">${subtitle}</text>` : ''}
  </g>`;

const arrow = (x1, y1, x2, y2, label) => `
  <g>
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#526480" stroke-width="1.5" marker-end="url(#a)"/>
    ${label ? `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle" class="l">${label}</text>` : ''}
  </g>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 560" width="900" height="560" role="img" aria-labelledby="title desc">
  <title id="title">Corporate Action Guard architecture</title>
  <desc id="desc">
    Two untrusted external sources feed a worker: the live xStocks production API and X Layer
    mainnet, chain 196, which is read only. The worker writes to an append-only evidence
    journal in PostgreSQL. The Fastify API reads that journal, evaluates the pure domain
    safety predicate, and issues a short-lived EIP-712 receipt only for an ALLOW decision. An
    integrator submits that receipt to ActionGuardAdapter on X Layer testnet, chain 1952,
    which independently re-verifies the multiplier nonce, the wrapper-to-asset relation, the
    guard window, the operation binding, and single consumption before permitting a protected
    action on the vault. The console reads the API over HTTP only and holds no server secret.
    An optional AI explainer receives redacted evidence and is structurally excluded from the
    decision path. A direct ERC-20 transfer bypasses the adapter entirely.
  </desc>
  <defs>
    <marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#526480"/>
    </marker>
  </defs>
  <style>
    .t { font: 600 13px 'Fira Sans', system-ui, sans-serif; fill: #f8fafc; }
    .s { font: 400 10px 'Fira Code', ui-monospace, monospace; fill: #94a3b8; }
    .l { font: 400 10px 'Fira Sans', system-ui, sans-serif; fill: #cbd5e1; }
    .h { font: 600 11px 'Fira Sans', system-ui, sans-serif; fill: #94a3b8; letter-spacing: .08em; }
  </style>
  <rect width="900" height="560" fill="#020617"/>

  <text x="24" y="30" class="h">UNTRUSTED SOURCES</text>
  ${box(24, 44, 180, 56, 'xStocks API', 'api.xstocks.fi/api/v2', '#0e1223', '#3b82f6')}
  ${box(24, 116, 180, 56, 'X Layer mainnet', 'chain 196 · READ ONLY', '#0e1223', '#3b82f6')}

  <text x="300" y="30" class="h">SERVICE</text>
  ${box(300, 44, 170, 56, 'Worker', 'observe · compare · journal', '#0e1223', '#526480')}
  ${box(300, 130, 170, 56, 'Fastify API', 'evaluatePreflight', '#0e1223', '#526480')}
  ${box(300, 216, 170, 56, 'Receipt signer', 'EIP-712 · ALLOW only', '#0e1223', '#c2670a')}

  <text x="300" y="330" class="h">DURABLE EVIDENCE</text>
  ${box(300, 344, 170, 56, 'Evidence journal', 'append-only · trigger', '#0e1223', '#16a34a')}

  <text x="560" y="30" class="h">ON CHAIN · 1952</text>
  ${box(560, 44, 200, 70, 'ActionGuardAdapter', 're-verifies chain facts', '#0e1223', '#16a34a')}
  ${box(560, 130, 200, 56, 'ProtectedVault', 'deposit · withdraw', '#0e1223', '#526480')}

  <text x="560" y="230" class="h">CONSUMERS</text>
  ${box(560, 244, 200, 56, 'Console', 'HTTP only · no secret', '#0e1223', '#526480')}
  ${box(560, 316, 200, 56, 'Integrator SDK', 'verifies before gas', '#0e1223', '#526480')}
  ${box(560, 400, 200, 56, 'AI explainer', 'non-authoritative', '#0e1223', '#8b5cf6')}

  ${arrow(204, 72, 300, 72, 'validated')}
  ${arrow(204, 144, 300, 90, '')}
  ${arrow(385, 100, 385, 344, 'journal')}
  ${arrow(385, 344, 385, 186, 'read')}
  ${arrow(470, 158, 300, 230, '')}
  ${arrow(470, 244, 560, 100, 'receipt')}
  ${arrow(660, 114, 660, 130, '')}
  ${arrow(470, 158, 560, 272, 'HTTP')}
  ${arrow(470, 372, 560, 428, 'redacted')}

  <g>
    <line x1="24" y1="470" x2="240" y2="470" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#a)"/>
    <text x="24" y="492" class="l" style="fill:#f87171">Direct ERC-20 transfer</text>
    <text x="24" y="508" class="s" style="fill:#f87171">bypasses the adapter entirely</text>
  </g>

  <text x="300" y="492" class="s">Mainnet is never written. The adapter cannot verify that the</text>
  <text x="300" y="506" class="s">off-chain API agreed — see ADR 0002 residual risks.</text>
</svg>
`;

fs.writeFileSync(OUT, svg);
console.log(
  `Wrote ${path.relative(path.resolve(import.meta.dirname, '..'), OUT)} (${svg.length} bytes).`,
);
