import { useState } from 'react';
import { useTradingStore } from '@/store/useTradingStore';
import logo from '@/resources/images/icon_256.png';

/** 이름 + 패스코드 로그인/가입 (OKX 스타일). 처음 쓰는 이름이면 자동 가입된다. */
export default function Login() {
  const login = useTradingStore((s) => s.login);
  const busy = useTradingStore((s) => s.busy);
  const error = useTradingStore((s) => s.error);

  const [name, setName] = useState('');
  const [passcode, setPasscode] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || passcode.length < 4 || busy) return;
    login(name.trim(), passcode).catch(() => {});
  };

  return (
    <div className="flex h-screen items-center justify-center bg-bg px-4 text-text">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-border bg-panel p-7 shadow-2xl"
      >
        <div className="mb-6 flex flex-col items-center text-center">
          <img src={logo} alt="ox64" className="mb-4 h-20 w-20" />
          <h1 className="text-2xl font-extrabold tracking-tight">ox64</h1>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            이름과 패스코드로 입장하세요.
            <br />
            처음 쓰는 이름이면 계정이 새로 만들어집니다.
          </p>
        </div>

        <label className="mb-1.5 block text-xs font-medium text-muted">이름</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={20}
          autoFocus
          placeholder="닉네임"
          className="mb-4 w-full rounded-lg bg-panel2 px-3.5 py-2.5 text-sm text-text outline-none ring-1 ring-border transition placeholder:text-muted/60 focus:ring-accent"
        />

        <label className="mb-1.5 block text-xs font-medium text-muted">패스코드</label>
        <input
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          type="password"
          maxLength={64}
          placeholder="4자 이상"
          className="mb-5 w-full rounded-lg bg-panel2 px-3.5 py-2.5 text-sm text-text outline-none ring-1 ring-border transition placeholder:text-muted/60 focus:ring-accent"
        />

        {error && (
          <p className="mb-4 rounded-lg bg-downDim px-3 py-2 text-xs text-down">{error}</p>
        )}

        <button
          type="submit"
          disabled={busy || !name.trim() || passcode.length < 4}
          className="w-full rounded-lg bg-accent py-3 text-sm font-bold text-black transition hover:brightness-110 disabled:opacity-40"
        >
          {busy ? '입장 중…' : '입장'}
        </button>
      </form>
    </div>
  );
}
