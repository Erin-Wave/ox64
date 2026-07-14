import { useState } from 'react';
import { useTradingStore } from '@/store/useTradingStore';

/** 이름 + 패스코드 로그인/가입. 처음 쓰는 이름이면 자동 가입된다. */
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
    <div className="flex h-screen items-center justify-center bg-bg px-4 text-white">
      <form
        onSubmit={submit}
        className="w-full max-w-xs rounded-lg border border-border bg-panel p-6"
      >
        <h1 className="mb-1 text-xl font-extrabold tracking-tight">ox64</h1>
        <p className="mb-5 text-xs text-muted">
          이름과 패스코드로 입장. 처음 쓰는 이름이면 계정이 새로 만들어져요.
        </p>

        <label className="mb-1 block text-xs text-muted">이름</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={20}
          autoFocus
          className="mb-3 w-full rounded bg-bg px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-muted"
        />

        <label className="mb-1 block text-xs text-muted">패스코드 (4자 이상)</label>
        <input
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          type="password"
          maxLength={64}
          className="mb-4 w-full rounded bg-bg px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-muted"
        />

        {error && <p className="mb-3 text-xs text-down">{error}</p>}

        <button
          type="submit"
          disabled={busy || !name.trim() || passcode.length < 4}
          className="w-full rounded bg-up py-2 text-sm font-semibold text-white disabled:opacity-40"
        >
          {busy ? '입장 중…' : '입장'}
        </button>
      </form>
    </div>
  );
}
