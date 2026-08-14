import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pages from 'vite-plugin-pages';
import tailwindcss from '@tailwindcss/vite';

// Trivial publishes what lands in `build/` — keep Vite's outDir pointed there
// or a publish ships nothing.
export default defineConfig({
  plugins: [
    react(),
    pages({
      dirs: 'src/pages',
      extensions: ['tsx'],
    }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // The SAME target the build uses, for the two esbuild passes `build.target` does NOT cover:
  // the dev server's transform (`esbuild`) and its dependency pre-bundler (`optimizeDeps`).
  // Without these, `pnpm dev` falls back to esbuild's chrome87/es2020 default and dies on
  // react-router's modern destructuring before the server ever listens. `pnpm build` is
  // unaffected, so the failure shows up only when you run the dev server.
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  build: {
    // Match the project's tsconfig `target: ES2022`. Without this, esbuild
    // (vite's transformer) falls back to its chrome87/es2020 default and, on
    // esbuild >=0.28.1, hard-errors lowering modern destructuring from deps
    // like react-router-dom ("Transforming destructuring … is not supported").
    target: 'es2022',
    outDir: 'build',
    emptyOutDir: true,
  },
});
