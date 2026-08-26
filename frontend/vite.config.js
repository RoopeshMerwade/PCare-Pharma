import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false,         // never expose source maps in production
    chunkSizeWarningLimit: 800,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    // api.test.js predates the component suite and runs without the DOM setup;
    // it must keep passing untouched — it is the contract for the layer this
    // redesign deliberately does not modify.
    include: ['src/**/*.test.{js,jsx}'],
  },
});
