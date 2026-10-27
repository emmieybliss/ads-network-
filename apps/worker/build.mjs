import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  external: ['@node-rs/argon2', 'pg', 'ioredis', 'bullmq', 'fastify', '@fastify/*', 'zod', 'nodemailer', 'image-size', 'pino'],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});
