import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * In development the service is proxied under /api, so the browser only ever
 * talks to one origin and CORS never enters the picture. Deployed, the two are
 * on different hosts and it does — which is why `corsOrigins` exists in the
 * service. Set VITE_API_URL to the service's public url there.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
