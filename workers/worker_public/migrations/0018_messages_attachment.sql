-- Tier-2 image reuse (TODO.new-era/8): a stored attachment rides its user
-- message, so follow-up turns can re-attach it server-side within the
-- conversation's ownership
ALTER TABLE messages ADD COLUMN attachment_id TEXT;
