import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SITE_PORT = 7544;

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Libraries change far less often than the app, so they get chunks of
        // their own that browsers keep cached across deploys.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          if (id.includes('lucide-react')) return 'icons';
          return 'vendor';
        },
      },
    },
  },
  server: {
    host: true,
    port: SITE_PORT,
    strictPort: true,
  },
  preview: {
    host: true,
    port: SITE_PORT,
    strictPort: true,
  },
});
