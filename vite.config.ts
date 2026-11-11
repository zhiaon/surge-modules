import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    // Some sandboxed / network-mounted filesystems return unreliable results
    // from fs.realpath, which breaks Vite's default symlink-aware resolution.
    // Keeping symlinks intact is harmless here (no pnpm/yarn links in play).
    preserveSymlinks: true,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
