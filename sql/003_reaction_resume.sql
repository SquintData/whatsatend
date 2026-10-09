ALTER TABLE conversations ADD COLUMN IF NOT EXISTS control_timestamp bigint NOT NULL DEFAULT 0;
UPDATE conversations cv SET control_timestamp = GREATEST(cv.control_timestamp,
  COALESCE(floor(extract(epoch FROM cv.automation_started_at))::bigint, 0),
  COALESCE((SELECT MAX(COALESCE(m.provider_timestamp,
    floor(extract(epoch FROM m.received_at))::bigint)) FROM messages m
    WHERE m.conversation_id = cv.id AND m.direction = 'outgoing'), 0));
CREATE TABLE IF NOT EXISTS reaction_commands (
  organization_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  provider_event_id text NOT NULL,
  provider_timestamp bigint NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, provider_event_id),
  FOREIGN KEY (organization_id, channel_id, conversation_id)
    REFERENCES conversations(organization_id, channel_id, id)
);
CREATE INDEX IF NOT EXISTS reaction_commands_conversation ON reaction_commands(conversation_id);
