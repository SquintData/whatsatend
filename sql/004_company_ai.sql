ALTER TABLE organizations
  ADD COLUMN ai_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN ai_model text NOT NULL DEFAULT 'gpt-4o-mini',
  ADD COLUMN ai_business_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN ai_tone text NOT NULL DEFAULT '',
  ADD COLUMN ai_instructions text NOT NULL DEFAULT '';

ALTER TABLE reply_jobs DROP CONSTRAINT reply_jobs_state_check;
ALTER TABLE reply_jobs ADD CONSTRAINT reply_jobs_state_check
  CHECK (state IN ('pending', 'generating', 'sending', 'sent', 'cancelled', 'failed', 'uncertain'));
ALTER TABLE reply_jobs ADD CONSTRAINT reply_jobs_organization_id_id_unique UNIQUE (organization_id, id);

CREATE TABLE ai_usage (
  reply_job_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  model text NOT NULL,
  input_tokens integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL CHECK (output_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, reply_job_id) REFERENCES reply_jobs(organization_id, id)
);
CREATE INDEX ai_usage_company_created ON ai_usage(organization_id, created_at);
