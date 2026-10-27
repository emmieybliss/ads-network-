/** Writes the generated OpenAPI document to docs/openapi.json without starting a server. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildApp } from '../app';
import { loadConfig } from '../config';

const config = loadConfig({ ...process.env, EVENT_PROCESSING: 'inline' } as NodeJS.ProcessEnv);
const app = await buildApp({ config, logger: false });
await app.ready();
const spec = app.swagger();
const out = process.argv[2] ?? join(process.cwd(), '..', '..', 'docs', 'openapi.json');
await writeFile(out, JSON.stringify(spec, null, 2));
console.log(`Wrote ${Object.keys(spec.paths ?? {}).length} paths to ${out}`);
await app.close();
