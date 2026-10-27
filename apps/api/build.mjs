import { build } from 'esbuild';

// Bundle the API (including workspace packages) into a single ESM file; npm dependencies stay external.
await build({
  entryPoints: ['src/server.ts', 'src/scripts/create-admin.ts', 'src/scripts/openapi.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  packages: 'external',
  plugins: [{
    name: 'workspace-inline',
    setup(b) {
      b.onResolve({ filter: /^@blissnova\// }, () => undefined);
    },
  }],
  external: ['@node-rs/argon2', 'pg', 'ioredis', 'bullmq', 'fastify', '@fastify/*', 'zod', 'nodemailer', 'image-size'],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});
