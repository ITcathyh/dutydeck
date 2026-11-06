import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { precompressAssets } from './vite-precompress';
const apiTarget = process.env.DUTYDECK_API_URL ?? 'http://127.0.0.1:4310';
export default defineConfig({
  plugins: [react(), precompressAssets()],
  server: { port: 4311, proxy: { '/api': apiTarget } },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // React 单独成块：否则 Rollup 会把入口共用的 React 塞进高亮块，首页就得预加载 Prism。
          if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(id)) return 'vendor-react';
          if (id.includes('/prism-react-renderer/')) return 'syntax-highlighter';
        }
      }
    }
  }
});
