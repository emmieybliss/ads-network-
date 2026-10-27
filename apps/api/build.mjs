import { cpSync, existsSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';

// Bundle the API and the workspace packages it uses into ESM files. The API's
// own npm dependencies stay external and are installed next to it.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@blissnova/')).flatMap((d) => [d, `${d}/*`]);

await build({
  entryPoints: ['src/server.ts', 'src/scripts/create-admin.ts', 'src/scripts/openapi.ts', 'src/scripts/seed.ts', 'src/scripts/migrate.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  external,
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});

// Ship the SQL migrations next to the bundle so `node dist/migrate.js` finds them.
cpSync(new URL('../../packages/database/migrations', import.meta.url), new URL('./dist/migrations', import.meta.url), { recursive: true });
// Ship the built ad tag too when it exists (build @blissnova/ad-tag first).
const sdk = new URL('../../sdk/ad-tag/dist/bn.js', import.meta.url);
if (existsSync(sdk)) cpSync(sdk, new URL('./dist/sdk/bn.js', import.meta.url));
