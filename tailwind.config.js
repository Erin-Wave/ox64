/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 테마별 값은 src/index.css 의 CSS 변수(--color-*)에서 정의(dark/light/high-contrast).
        // rgb(var(...) / <alpha-value>) 패턴이라 bg-panel2/80 같은 opacity modifier 도 그대로 동작.
        bg: 'rgb(var(--color-bg) / <alpha-value>)',
        panel: 'rgb(var(--color-panel) / <alpha-value>)',
        panel2: 'rgb(var(--color-panel2) / <alpha-value>)',
        elevated: 'rgb(var(--color-elevated) / <alpha-value>)',
        border: 'rgb(var(--color-border) / <alpha-value>)',
        up: 'rgb(var(--color-up) / <alpha-value>)',
        upDim: 'rgb(var(--color-upDim) / <alpha-value>)',
        down: 'rgb(var(--color-down) / <alpha-value>)',
        downDim: 'rgb(var(--color-downDim) / <alpha-value>)',
        muted: 'rgb(var(--color-muted) / <alpha-value>)',
        text: 'rgb(var(--color-text) / <alpha-value>)',
        accent: 'rgb(var(--color-accent) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Proxima Nova', 'Apple SD Gothic Neo', 'Malgun Gothic', 'sans-serif'],
        mono: ['Proxima Nova', 'Apple SD Gothic Neo', 'Malgun Gothic', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
