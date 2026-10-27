import { build } from 'esbuild';

const minify = process.env.NODE_ENV !== 'development';
const r = await build({
  entryPoints: ['src/bn.ts'],
  bundle: true,
  format: 'iife',
  target: ['es2018'],
  minify,
  sourcemap: false,
  legalComments: 'none',
  outfile: 'dist/bn.js',
  metafile: true,
  banner: { js: '/* BlissNova ad tag. Serves advertisements; see the site owner\'s privacy policy. */' },
});
const size = Object.values(r.metafile.outputs)[0].bytes;
console.log(`dist/bn.js ${(size / 1024).toFixed(1)} kB${minify ? ' (minified)' : ''}`);
