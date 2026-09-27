-- the feedback vote's optional reason (the 👎 reason chips) — read by the
-- triage clustering, never by the answer path
ALTER TABLE feedback ADD COLUMN note TEXT;
