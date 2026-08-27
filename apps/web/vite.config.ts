import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const apiTarget = process.env.DOCKMUX_API_URL ?? 'http://127.0.0.1:4310';
export default defineConfig({
  plugins: [react()],
  server: { port: 4311, proxy: { '/api': apiTarget } },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/prism-react-renderer/')) return 'syntax-highlighter';
        }
      }
    }
  }
});
