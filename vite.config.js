import { defineConfig } from 'vite';

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// In development the API server (server/, port 3000) runs beside Vite.
const proxy = { '/api': 'http://localhost:3000' };

export default defineConfig({
  server: { headers, proxy },
  preview: { headers, proxy },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
