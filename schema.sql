-- ox64 D1 스키마 (서버 권위 백엔드)
-- 적용: wrangler d1 execute ox64 --remote --file=./schema.sql
--   (로컬 개발: --local)

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT UNIQUE NOT NULL,
  passcode_hash TEXT NOT NULL,
  balance       REAL NOT NULL DEFAULT 10000,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  side        TEXT NOT NULL,          -- 'long' | 'short'
  entry_price REAL NOT NULL,
  size        REAL NOT NULL,
  leverage    INTEGER NOT NULL,
  margin      REAL NOT NULL,          -- 차감된 증거금
  opened_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id);

CREATE TABLE IF NOT EXISTS orders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  side       TEXT NOT NULL,
  price      REAL NOT NULL,           -- 서버 체결가
  size       REAL NOT NULL,
  leverage   INTEGER NOT NULL,
  kind       TEXT NOT NULL,           -- 'open' | 'close'
  pnl        REAL,                    -- close 시 실현손익
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
