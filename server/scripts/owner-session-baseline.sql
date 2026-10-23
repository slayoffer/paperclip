-- Run with psql variables company_id and window_end (an ISO 8601 UTC time).
-- This query returns aggregates only. It does not return issue or run content.
WITH parameters AS (
  SELECT :'company_id'::uuid AS company_id,
         :'window_end'::timestamptz AS window_end
), adapter_types(adapter_type) AS (
  VALUES ('codex_local'), ('claude_local')
), resume_states(resume_state) AS (
  VALUES ('resumed'), ('fresh'), ('unknown')
), history AS (
  SELECT r.id, r.agent_id, r.created_at, r.status,
         r.session_id_before, r.session_id_after, a.adapter_type,
         a.adapter_type = 'codex_local'
           AND NOT coalesce(r.result_json ? 'stopReason', false) AS codex_cli,
         CASE WHEN jsonb_typeof(r.usage_json -> 'rawInputTokens') = 'number'
              THEN (r.usage_json ->> 'rawInputTokens')::numeric
              WHEN r.usage_json ->> 'usageSource' IS DISTINCT FROM 'session_delta'
                AND jsonb_typeof(r.usage_json -> 'inputTokens') = 'number'
              THEN (r.usage_json ->> 'inputTokens')::numeric
         END AS raw_input_tokens,
         CASE WHEN jsonb_typeof(r.usage_json -> 'inputTokens') = 'number'
              THEN (r.usage_json ->> 'inputTokens')::numeric
         END AS reported_input_tokens
  FROM heartbeat_runs r
  JOIN agents a ON a.id = r.agent_id AND a.company_id = r.company_id
  CROSS JOIN parameters p
  WHERE r.company_id = p.company_id
    AND a.adapter_type IN ('codex_local', 'claude_local')
    AND r.created_at < p.window_end
    AND r.status IN ('succeeded', 'failed', 'timed_out', 'cancelled')
), prior_totals AS (
  -- Include history before the window to measure its first resumed run.
  SELECT *, lag(raw_input_tokens) OVER (
    PARTITION BY agent_id, session_id_after ORDER BY created_at, id
  ) AS previous_raw_input_tokens
  FROM history
), classified AS (
  SELECT h.adapter_type,
         CASE
           WHEN h.status <> 'succeeded' OR nullif(btrim(h.session_id_after), '') IS NULL THEN 'unknown'
           WHEN nullif(btrim(h.session_id_before), '') = h.session_id_after THEN 'resumed'
           ELSE 'fresh'
         END AS resume_state,
         CASE
           WHEN h.status <> 'succeeded' THEN NULL
           WHEN NOT h.codex_cli AND h.reported_input_tokens >= 0 THEN h.reported_input_tokens
           WHEN h.codex_cli AND h.raw_input_tokens >= 0 THEN
             CASE
               WHEN nullif(btrim(h.session_id_before), '') = h.session_id_after THEN
                 CASE WHEN h.previous_raw_input_tokens >= 0
                      THEN CASE WHEN h.raw_input_tokens >= h.previous_raw_input_tokens
                                THEN h.raw_input_tokens - h.previous_raw_input_tokens
                                ELSE h.raw_input_tokens END END
               ELSE h.raw_input_tokens
             END
         END AS input_tokens
  FROM prior_totals h
  CROSS JOIN parameters p
  WHERE h.created_at >= p.window_end - interval '7 days'
), aggregates AS (
  SELECT adapter_type, resume_state, count(*) AS runs,
         count(input_tokens) AS token_samples,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY input_tokens) AS median_input_tokens
  FROM classified
  GROUP BY adapter_type, resume_state
)
SELECT p.window_end - interval '7 days' AS window_start,
       p.window_end,
       t.adapter_type,
       s.resume_state,
       coalesce(a.runs, 0) AS runs,
       round(100.0 * coalesce(a.runs, 0) / nullif(
         sum(coalesce(a.runs, 0)) OVER (PARTITION BY t.adapter_type), 0
       ), 2) AS percent_of_terminal_runs,
       coalesce(a.token_samples, 0) AS token_samples,
       a.median_input_tokens
FROM adapter_types t
CROSS JOIN resume_states s
CROSS JOIN parameters p
LEFT JOIN aggregates a USING (adapter_type, resume_state)
ORDER BY t.adapter_type, s.resume_state;
