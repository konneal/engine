-- The per-answer context mark (TODO.ai-platform/02): the transcript marks
-- the context each answer was grounded in (the panel's declared chip as
-- the service APPLIED it — the context_applied echo), so a resumed
-- conversation keeps its honest context lines. NULL means the answer
-- carries no recorded context (pre-chips history included) — the panel
-- renders no context line for those rather than guessing one.
ALTER TABLE messages ADD COLUMN context_applied TEXT;
