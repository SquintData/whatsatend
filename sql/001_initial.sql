CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS channels (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  instance text NOT NULL,
  session text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (instance, session),
  UNIQUE (organization_id, id)
);
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  chat_id text NOT NULL,
  mode text NOT NULL DEFAULT 'monitoring' CHECK (mode IN ('monitoring', 'human')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, channel_id) REFERENCES channels(organization_id, id),
  UNIQUE (channel_id, chat_id),
  UNIQUE (organization_id, channel_id, id)
);
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  provider_message_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  body text NOT NULL,
  provider_timestamp bigint,
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, channel_id, conversation_id)
    REFERENCES conversations(organization_id, channel_id, id),
  UNIQUE (channel_id, provider_message_id)
);
CREATE INDEX IF NOT EXISTS messages_history ON messages(organization_id, conversation_id, received_at);
