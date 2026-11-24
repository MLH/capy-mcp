ALTER TABLE app_grants ADD COLUMN created_at INTEGER CHECK (created_at >= 0);
ALTER TABLE app_grants ADD COLUMN client_label TEXT CHECK (length(client_label) BETWEEN 1 AND 256);
