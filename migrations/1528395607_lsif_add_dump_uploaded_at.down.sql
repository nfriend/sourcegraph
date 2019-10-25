BEGIN;

ALTER TABLE lsif_dumps DROP COLUMN uploaded_at;

COMMIT;
