import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildOpenApiDocument } from './openapi.js';

const target = path.resolve(import.meta.dirname, '../openapi/openapi.json');
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
process.stdout.write(`wrote ${target}\n`);
