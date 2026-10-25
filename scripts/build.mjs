import { build } from 'esbuild';
await build({ entryPoints: ['src/main/main.ts', 'src/core/host.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', outdir: 'dist', outbase: 'src', sourcemap: true });
await build({ entryPoints: ['src/main/preload.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], outfile: 'dist/main/preload.cjs' });
