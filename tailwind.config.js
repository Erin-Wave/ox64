/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 거래소 다크 테마 팔레트
        bg: '#0b0e11',
        panel: '#161a1e',
        border: '#2b3139',
        up: '#26a69a',
        down: '#ef5350',
        muted: '#848e9c',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
