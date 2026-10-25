import { build } from 'esbuild';
// Preserve the PDF bootstrap as an ESM dependency: its globals must exist before PDF.js evaluates.
await build({ entryPoints: ['src/main/main.ts', 'src/core/host.ts', 'src/core/pdf-platform.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', external: ['./pdf-platform.js'], outdir: 'dist', outbase: 'src', sourcemap: true });
await build({ entryPoints: ['src/main/preload.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], outfile: 'dist/main/preload.cjs' });
