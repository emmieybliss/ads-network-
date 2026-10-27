import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

// Bundle the worker and the workspace code it uses. Its own npm dependencies stay external.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@blissnova/')).flatMap((d) => [d, `${d}/*`]);

await build({
  entryPoints: ['src/index.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  external,
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});
