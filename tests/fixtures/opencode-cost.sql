CREATE TABLE session_v2 (
  id TEXT PRIMARY KEY,
  cost REAL NOT NULL DEFAULT 0,
  time_created INTEGER NOT NULL
);

INSERT INTO session_v2 (id, cost, time_created) VALUES
  ('ses-paid-1', 0.10, 1767225601000),
  ('ses-paid-2', 0.25, 1767225602000),
  ('ses-free-0', 0.00, 1767225603000);
