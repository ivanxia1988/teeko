CREATE TABLE teeko_classroom_note_state (
  classroom_id uuid PRIMARY KEY REFERENCES teeko_classrooms(id) ON DELETE CASCADE,
  captured_from_start boolean NOT NULL,
  capped boolean NOT NULL DEFAULT false
);
CREATE TABLE teeko_classroom_note_records (
  classroom_id uuid NOT NULL REFERENCES teeko_classrooms(id) ON DELETE CASCADE,
  connection_epoch integer NOT NULL CHECK (connection_epoch > 0),
  item_id text NOT NULL CHECK (length(item_id) BETWEEN 1 AND 200),
  source_revision integer NOT NULL CHECK (source_revision >= 0),
  card jsonb NOT NULL CHECK (jsonb_typeof(card) = 'object' AND octet_length(card::text) <= 8192),
  saved_at timestamptz NOT NULL,
  PRIMARY KEY (classroom_id,connection_epoch,item_id)
);
CREATE INDEX teeko_classroom_note_order ON teeko_classroom_note_records(classroom_id,saved_at DESC,connection_epoch DESC,item_id DESC);
CREATE TABLE teeko_classroom_note_jobs (
  id uuid PRIMARY KEY,
  classroom_id uuid NOT NULL UNIQUE REFERENCES teeko_classrooms(id) ON DELETE CASCADE,
  source_revision integer NOT NULL CHECK (source_revision >= 0),
  status text NOT NULL CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  run_after timestamptz NOT NULL,
  owner_token uuid,
  lease_until timestamptz,
  result jsonb CHECK (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 2097152),
  error_code text CHECK (error_code IN ('PROCESSING_FAILED','LEASE_EXHAUSTED','SOURCE_CHANGED')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((status = 'running' AND owner_token IS NOT NULL AND lease_until IS NOT NULL) OR (status <> 'running' AND owner_token IS NULL AND lease_until IS NULL)),
  CHECK ((status = 'succeeded') = (result IS NOT NULL))
);
CREATE INDEX teeko_classroom_note_jobs_ready ON teeko_classroom_note_jobs(run_after,id) WHERE status IN ('pending','running');
