import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    target: 'es2020',
    // 트레이딩뷰 차트/rxjs 를 별도 청크로 분리해 초기 로드 최적화
    rollupOptions: {
      output: {
        manualChunks: {
          charts: ['lightweight-charts'],
          rx: ['rxjs'],
        },
      },
    },
  },
});
