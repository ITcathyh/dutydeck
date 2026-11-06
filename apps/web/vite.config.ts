import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const apiTarget = process.env.DUTYDECK_API_URL ?? 'http://127.0.0.1:4310';
export default defineConfig({
  plugins: [react()],
  server: { port: 4311, proxy: { '/api': apiTarget } },
  build: {
    rollupOptions: {
      // Let Rollup drop unused @dutydeck/shared exports (module-level z.object() calls otherwise pin
      // every schema into the first chunk). Modules in packages/shared must stay free of top-level
      // side effects. Matches both src (development condition) and dist resolutions.
      treeshake: { moduleSideEffects: id => !id.includes('/packages/shared/') },
      output: {
        manualChunks(id) {
          if (id.includes('/prism-react-renderer/')) return 'syntax-highlighter';
        }
      }
    }
  }
});
