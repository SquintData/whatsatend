ALTER TABLE channels
  ADD COLUMN automation_scope text NOT NULL DEFAULT 'disabled',
  ADD COLUMN automation_test_chat_id text,
  ADD COLUMN automation_activated_at timestamptz;
ALTER TABLE channels ADD CONSTRAINT channels_automation_scope_check
  CHECK (automation_scope IN ('disabled', 'test', 'all'));
ALTER TABLE channels ADD CONSTRAINT channels_automation_test_chat_check CHECK (
  (automation_scope = 'test' AND automation_test_chat_id ~ '^[0-9]+(@c[.]us|@s[.]whatsapp[.]net|@lid)$')
  OR (automation_scope IN ('disabled', 'all') AND automation_test_chat_id IS NULL)
);
CREATE INDEX channels_enabled_automation ON channels(automation_scope, organization_id) WHERE automation_scope <> 'disabled';
