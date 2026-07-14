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
        // 사이트 전체 Proxima Nova 통일. mono 도 Proxima 로 두되
        // 숫자 정렬은 index.css 의 font-variant-numeric: tabular-nums 로 확보.
        sans: ['Proxima Nova', 'Apple SD Gothic Neo', 'Malgun Gothic', 'sans-serif'],
        mono: ['Proxima Nova', 'Apple SD Gothic Neo', 'Malgun Gothic', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
