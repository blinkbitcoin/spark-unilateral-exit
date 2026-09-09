import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist-desktop', { recursive: true });
await build({ entryPoints: ['desktop/main.ts'], outfile: 'dist-desktop/main.cjs',
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', target: 'node22' });
await build({ entryPoints: ['desktop/renderer.ts'], outfile: 'dist-desktop/renderer.js',
  bundle: true, platform: 'browser', format: 'iife', target: 'es2022' });
await build({ entryPoints: ['desktop/preload.ts'], outfile: 'dist-desktop/preload.cjs',
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' });
for (const name of ['index.html', 'style.css']) await copyFile(`desktop/${name}`, `dist-desktop/${name}`);
await mkdir('dist-desktop/assets', { recursive: true });
for (const name of ['blink-logo.svg', 'ibm-plex-sans.ttf', 'OFL.txt']) await copyFile(`desktop/assets/${name}`, `dist-desktop/assets/${name}`);
