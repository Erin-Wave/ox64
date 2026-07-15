import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/store/useSettingsStore'; // 모듈 로드 시 저장된 테마를 즉시 적용(FOUC 방지) — App import 보다 먼저
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
