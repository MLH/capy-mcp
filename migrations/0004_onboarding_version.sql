ALTER TABLE pending_authorizations ADD COLUMN onboarding_version INTEGER CHECK (onboarding_version >= 0);
