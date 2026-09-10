-- Projects (#187 design): a container owning memory files and a set of
-- conversations. Personal memories stay in `memories`; project files are
-- their own table so ownership is the project (and, through it, the
-- owner). Moving a conversation re-scopes its NEXT answer only —
-- history keeps its recorded grounding (design rule 3).
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,             -- p:<hex16>
  sub TEXT NOT NULL,               -- owner (session sub)
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_files (
  id TEXT PRIMARY KEY,             -- pf:<hex16>
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_id, updated_at);
ALTER TABLE conversations ADD COLUMN project_id TEXT;
