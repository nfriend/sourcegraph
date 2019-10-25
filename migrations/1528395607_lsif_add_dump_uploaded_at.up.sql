BEGIN;

DROP INDEX lsif_dumps_uploaded_at;
DROP INDEX lsif_dumps_visible_at_tip;
ALTER TABLE lsif_dumps ADD COLUMN uploaded_at timestamp with time zone NOT NULL DEFAULT now();

COMMIT;
