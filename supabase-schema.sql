-- TaskLaunchpad Schema
-- Run this in your Supabase SQL editor

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  due_date TIMESTAMPTZ,
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  assignee_email TEXT,
  project_name TEXT,
  status TEXT DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'in_review', 'done')),
  created_by TEXT,              -- user's email, set by create_task tool
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-update updated_at on row modification
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status ON tasks (assignee_email, status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks (project_name);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks (due_date);

-- Checkpoint tables are auto-created by checkpointer.setup() at app startup
-- No manual DDL needed for checkpoints
