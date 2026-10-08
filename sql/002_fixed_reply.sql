ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_mode_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_mode_check
  CHECK (mode IN ('monitoring', 'human', 'auto'));
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS automation_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS automation_started_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS messages_scoped_id
  ON messages(organization_id, channel_id, conversation_id, id);
CREATE TABLE IF NOT EXISTS reply_jobs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  source_message_id uuid NOT NULL UNIQUE,
  epoch integer NOT NULL,
  body text NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'sending', 'sent', 'cancelled', 'failed', 'uncertain')),
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  FOREIGN KEY (organization_id, channel_id, conversation_id)
    REFERENCES conversations(organization_id, channel_id, id),
  FOREIGN KEY (organization_id, channel_id, conversation_id, source_message_id)
    REFERENCES messages(organization_id, channel_id, conversation_id, id),
  UNIQUE (channel_id, provider_message_id)
);
CREATE INDEX IF NOT EXISTS reply_jobs_pending ON reply_jobs(created_at) WHERE state = 'pending';
