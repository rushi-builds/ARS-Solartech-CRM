// Bundles the Worker and prepares the deployment manifest.
import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';

const COMPAT_DATE = '2026-11-19';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

await build({
  entryPoints: ['src/worker.ts'],
  outfile: 'dist/worker.js',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'],
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});

await cp('public', 'dist/public', { recursive: true });

await writeFile(
  'dist/manifest.json',
  JSON.stringify(
    {
      entrypoint: 'worker.js',
      compatibilityDate: COMPAT_DATE,
      modules: [{ name: 'worker.js', type: 'esm', path: './worker.js' }],
      assetsDirectory: './public',
      spa: true,
    },
    null,
    2,
  ),
);

console.log('built dist/worker.js + dist/public + dist/manifest.json');
