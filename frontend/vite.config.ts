/// <reference types="vitest" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // IndexedDB in memory, so the Dexie-backed crypto stores run under test unchanged.
    setupFiles: ['fake-indexeddb/auto'],
  },
  server: {
    port: 5173,
    proxy: {
      // Keeps the browser on one origin in dev, so CORS and cookie rules behave the way
      // they will in production behind a single edge.
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/.well-known': { target: 'http://localhost:8080', changeOrigin: true },
      '/ws': { target: 'http://localhost:8081', changeOrigin: true, ws: true },
    },
  },
});
