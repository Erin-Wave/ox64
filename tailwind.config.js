/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // OKX 스타일 다크 팔레트
        bg: '#0b0d0f', // 앱 배경(near-black)
        panel: '#15171b', // 카드/패널
        panel2: '#1c1f24', // 입력/hover 표면
        elevated: '#23272e', // 버튼/구분 표면
        border: '#282c33', // 경계선
        up: '#00c076', // 롱/상승 그린 (OKX)
        upDim: '#0f3a2e', // 그린 배경틴트
        down: '#f6465d', // 숏/하락 레드 (OKX)
        downDim: '#3a1f26', // 레드 배경틴트
        muted: '#7c828b', // 보조 텍스트
        text: '#eaecef', // 기본 텍스트
        accent: '#00c076', // 강조(링크/포커스/CTA)
      },
      fontFamily: {
        sans: ['Proxima Nova', 'Apple SD Gothic Neo', 'Malgun Gothic', 'sans-serif'],
        mono: ['Proxima Nova', 'Apple SD Gothic Neo', 'Malgun Gothic', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
