-- Run with psql variables company_id and window_end (an ISO 8601 UTC time).
-- This query returns aggregates only. It does not return issue or run content.
WITH parameters AS (
  SELECT :'company_id'::uuid AS company_id,
         :'window_end'::timestamptz AS window_end
), adapter_types(adapter_type) AS (
  VALUES ('codex_local'), ('claude_local')
), resume_states(resume_state) AS (
  VALUES ('resumed'), ('fresh'), ('unknown')
), classified AS (
  SELECT a.adapter_type,
         CASE
           WHEN nullif(btrim(r.session_id_after), '') IS NULL THEN 'unknown'
           WHEN nullif(btrim(r.session_id_before), '') = r.session_id_after THEN 'resumed'
           ELSE 'fresh'
         END AS resume_state,
         CASE
           WHEN jsonb_typeof(r.usage_json -> 'inputTokens') = 'number'
           THEN CASE WHEN (r.usage_json ->> 'inputTokens')::numeric >= 0
                     THEN (r.usage_json ->> 'inputTokens')::numeric END
         END AS input_tokens
  FROM heartbeat_runs r
  JOIN agents a ON a.id = r.agent_id AND a.company_id = r.company_id
  CROSS JOIN parameters p
  WHERE r.company_id = p.company_id
    AND a.adapter_type IN ('codex_local', 'claude_local')
    AND r.created_at >= p.window_end - interval '7 days'
    AND r.created_at < p.window_end
    AND r.status IN ('succeeded', 'failed', 'timed_out', 'cancelled')
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
