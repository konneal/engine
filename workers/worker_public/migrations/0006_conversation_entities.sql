-- Cross-turn entity memory (G5): resolved entities per conversation so
-- pronouns/ellipsis in follow-ups resolve O(1) instead of re-deriving
-- from raw history text every turn.
CREATE TABLE IF NOT EXISTS conversation_entities (
  conversation_id TEXT NOT NULL,
  entity TEXT NOT NULL,          -- display form, e.g. "OIML R 60-1:2021"
  kind TEXT NOT NULL,            -- document | term
  ts INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, entity)
);
CREATE INDEX IF NOT EXISTS idx_conv_entities ON conversation_entities(conversation_id);
