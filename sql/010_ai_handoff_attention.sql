ALTER TABLE conversations
  ADD COLUMN ai_handoff_reason text,
  ADD COLUMN ai_handoff_at timestamptz;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_ai_handoff_reason_check
    CHECK (ai_handoff_reason IS NULL OR ai_handoff_reason IN (
      'needs_person', 'unknown_information', 'sensitive_request', 'other'
    )),
  ADD CONSTRAINT conversations_ai_handoff_pair_check
    CHECK ((ai_handoff_reason IS NULL) = (ai_handoff_at IS NULL)),
  ADD CONSTRAINT conversations_ai_handoff_human_check
    CHECK (ai_handoff_reason IS NULL OR mode = 'human');

CREATE INDEX conversations_ai_handoff_recent
  ON conversations(ai_handoff_at DESC, id DESC)
  WHERE ai_handoff_reason IS NOT NULL;
