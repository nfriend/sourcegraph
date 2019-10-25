BEGIN;

ALTER TABLE lsif_dumps ADD COLUMN uploaded_at timestamp with time zone NOT NULL DEFAULT now();

COMMIT;
