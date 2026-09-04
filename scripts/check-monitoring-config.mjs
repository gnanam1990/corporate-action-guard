#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';

const root = path.resolve(import.meta.dirname, '..');
const load = (relative) => {
  const document = parseDocument(readFileSync(path.join(root, relative), 'utf8'));
  if (document.errors.length > 0) {
    throw new Error(`${relative}: ${document.errors.map((error) => error.message).join('; ')}`);
  }
  return document.toJS();
};

const alerts = load('infra/monitoring/alerts.yml');
const rules = alerts?.groups?.flatMap((group) => group.rules ?? []) ?? [];
const requiredAlerts = new Set([
  'CorporateActionGuardApiDown',
  'CorporateActionGuardComponentNotReady',
  'CorporateActionGuardNoPreflightTraffic',
]);
const seen = new Set();
for (const rule of rules) {
  if (typeof rule.alert !== 'string' || typeof rule.expr !== 'string' || rule.expr.trim() === '') {
    throw new Error('every alert must have a non-empty name and expression');
  }
  if (seen.has(rule.alert)) throw new Error(`duplicate alert name: ${rule.alert}`);
  seen.add(rule.alert);
  if (!['critical', 'warning'].includes(rule.labels?.severity)) {
    throw new Error(`${rule.alert}: severity must be critical or warning`);
  }
}
for (const alert of requiredAlerts) {
  if (!seen.has(alert)) throw new Error(`required alert is absent: ${alert}`);
}
const noTraffic = rules.find((rule) => rule.alert === 'CorporateActionGuardNoPreflightTraffic');
if (!noTraffic.expr.includes('absent(cag_preflight_decisions_total)')) {
  throw new Error('no-traffic alert must also fire when the metric has never existed');
}

const prometheus = load('infra/monitoring/prometheus.yml');
if (!prometheus?.rule_files?.includes('/etc/prometheus/alerts.yml')) {
  throw new Error('Prometheus config does not load /etc/prometheus/alerts.yml');
}
const apiJob = prometheus?.scrape_configs?.find(
  (job) => job.job_name === 'corporate-action-guard-api',
);
if (apiJob?.metrics_path !== '/metrics') {
  throw new Error('API scrape job must use /metrics');
}
const targets = apiJob?.static_configs?.flatMap((config) => config.targets ?? []) ?? [];
if (!targets.includes('api:4000')) throw new Error('API scrape target api:4000 is absent');

process.stdout.write(`Monitoring config: OK (${rules.length} alert rules).\n`);
