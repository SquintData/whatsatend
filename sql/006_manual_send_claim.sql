ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS manual_send_started_at timestamptz;
