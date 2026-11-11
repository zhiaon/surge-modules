/**
 * Test runner.
 *
 * The two suites import TypeScript with extension-less specifiers, which node
 * cannot resolve on its own. They are bundled with the esbuild copy that ships
 * with Vite, then executed — so `npm test` works without adding a test
 * framework or another build step to the repo.
 */

import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'node_modules', '.test-build');
mkdirSync(outDir, { recursive: true });

const suites = [
  { name: 'sql-contract', entry: 'tests/sql-contract.test.ts' },
  { name: 'security', entry: 'tests/security.test.ts' },
  { name: 'workers-e2e', entry: 'tests/workers.e2e.test.ts' },
  { name: 'admin', entry: 'tests/admin.test.ts' },
  { name: 'phase6', entry: 'tests/phase6.test.ts' },
  { name: 'webhook', entry: 'tests/webhook.test.ts' },
  { name: 'batching', entry: 'tests/batching.test.ts' },
  { name: 'phase7', entry: 'tests/phase7.test.ts' },
];

let failed = 0;

for (const suite of suites) {
  const outfile = join(outDir, `${suite.name}.mjs`);
  await build({
    entryPoints: [join(root, suite.entry)],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    external: ['node:*'],
    logLevel: 'error',
  });

  try {
    execFileSync(process.execPath, [outfile], { stdio: 'inherit', cwd: root });
  } catch {
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`\n${failed} suite(s) failed`);
  process.exit(1);
}
console.log('\nAll suites passed');
