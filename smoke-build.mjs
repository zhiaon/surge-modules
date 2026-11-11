import { build } from 'esbuild';
await build({
  entryPoints: ['smoke-entry.tsx'],
  bundle: true,
  outfile: 'smoke-out.cjs',
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  target: 'node20',
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
  tsconfig: 'tsconfig.json',
  external: ['react', 'react-dom', 'react-dom/server', 'react-router-dom'],
  logLevel: 'error',
});
