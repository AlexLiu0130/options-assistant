ALTER TABLE paper_orders
  ADD COLUMN IF NOT EXISTS strategy_id text,
  ADD COLUMN IF NOT EXISTS strategy_name text,
  ADD COLUMN IF NOT EXISTS reject_reason text,
  ADD COLUMN IF NOT EXISTS strategy_snapshot jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS fill_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS position_id uuid;

ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS strategy_id text,
  ADD COLUMN IF NOT EXISTS strategy_name text,
  ADD COLUMN IF NOT EXISTS opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS entry_snapshot jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS close_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS strategy_snapshot jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS legs_snapshot jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS user_notes text;

DO $$
DECLARE
  constraint_record record;
  index_record record;
BEGIN
  FOR constraint_record IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = 'paper_positions'
      AND c.contype = 'u'
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname)
        FROM unnest(c.conkey) key(attnum)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key.attnum
      ) IN (ARRAY['ticker'], ARRAY['account_id', 'ticker'], ARRAY['ticker', 'user_id'])
  LOOP
    EXECUTE format('ALTER TABLE paper_positions DROP CONSTRAINT %I', constraint_record.conname);
  END LOOP;

  FOR index_record IN
    SELECT i.relname
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = 'paper_positions'
      AND x.indisunique
      AND NOT x.indisprimary
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname)
        FROM unnest(x.indkey) key(attnum)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key.attnum
      ) IN (ARRAY['ticker'], ARRAY['account_id', 'ticker'], ARRAY['ticker', 'user_id'])
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', index_record.relname);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS paper_orders_user_ticker_submitted_idx
  ON paper_orders (user_id, ticker, submitted_at DESC);

CREATE INDEX IF NOT EXISTS paper_positions_user_ticker_status_idx
  ON paper_positions (user_id, ticker, status);

CREATE INDEX IF NOT EXISTS paper_positions_strategy_idx
  ON paper_positions (user_id, strategy_id);
