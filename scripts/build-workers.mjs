/**
 * Bundles both workers to plain ESM once.
 *
 * The dev server must not bundle at startup: each esbuild run leaves a service
 * process behind, and on this device a few of those are enough to trigger the
 * OS OOM killer. Bundling here (and killing the service) keeps the dev server
 * to a single Node process.
 *
 * Also run before `wrangler deploy` if you want to inspect the output.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  ['workers/site/index.ts', '.devbuild/site.mjs'],
  ['workers/module-proxy/index.ts', '.devbuild/proxy.mjs'],
];

for (const [entry, out] of targets) {
  await build({
    entryPoints: [join(root, entry)],
    outfile: join(root, out),
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    target: 'es2022',
    logLevel: 'error',
  });
  console.log(`built ${out}`);
}

// esbuild keeps a long-lived service; release it immediately
try {
  execFileSync('pkill', ['-f', 'esbuild --service']);
} catch {
  /* nothing to kill */
}
