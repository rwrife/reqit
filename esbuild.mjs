import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const opts = {
  entryPoints: ['src/extension/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(opts);
  await ctx.watch();
} else {
  await build(opts);
}
