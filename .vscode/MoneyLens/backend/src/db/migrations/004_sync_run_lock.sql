BEGIN;

CREATE UNIQUE INDEX sync_runs_one_active_per_user_index
    ON sync_runs (user_id)
    WHERE status IN ('pending', 'running');

COMMIT;
