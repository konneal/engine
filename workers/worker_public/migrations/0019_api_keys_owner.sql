-- API keys draw from their OWNER MEMBER's credit cap (the owner's
-- 2026-10-12 direction): a member-issued key is not a separate budget
-- tier — key traffic and the member's web traffic share ONE daily
-- allowance (sub:<owner> bucket). Keys without an owner (service
-- keys) keep the per-key cap.
ALTER TABLE api_keys ADD COLUMN owner_sub TEXT;
