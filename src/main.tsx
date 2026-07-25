import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/store/useSettingsStore'; // 모듈 로드 시 저장된 테마를 즉시 적용(FOUC 방지) — App import 보다 먼저
import './index.css';

// 코인 트레이딩과 무관한 퍼즐게임(/b)은 별도 진입점 — 라우터 없이 pathname 으로만 분기해
// 트레이딩 쪽 번들(zustand 트레이딩 스토어 등)이 퍼즐 페이지에 딸려오지 않게 한다.
const isPuzzle = location.pathname === '/b' || location.pathname.startsWith('/b/');

async function render() {
  const root = createRoot(document.getElementById('root')!);
  if (isPuzzle) {
    document.title = 'ox64 · 보석찾기';
    const { default: PuzzleApp } = await import('./puzzle/PuzzleApp');
    root.render(
      <StrictMode>
        <PuzzleApp />
      </StrictMode>,
    );
  } else {
    const { default: App } = await import('./App');
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  }
}
render();
