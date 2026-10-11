-- Provider/control timestamps are Unix seconds with up to millisecond precision.
ALTER TABLE conversations
  ALTER COLUMN control_timestamp TYPE numeric(16,3) USING control_timestamp::numeric(16,3);
ALTER TABLE messages
  ALTER COLUMN provider_timestamp TYPE numeric(16,3) USING provider_timestamp::numeric(16,3);
ALTER TABLE reaction_commands
  ALTER COLUMN provider_timestamp TYPE numeric(16,3) USING provider_timestamp::numeric(16,3);
