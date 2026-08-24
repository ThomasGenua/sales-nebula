import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SITE_PORT = 7544;

export default defineConfig({
  plugins: [react()],
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
