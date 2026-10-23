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
         END AS reported_input_tokens,
         -- The service's cumulative sample (readRawUsageTotals): raw value, else reported value, else 0.
         greatest(0, floor(coalesce(
           CASE WHEN jsonb_typeof(r.usage_json -> 'rawInputTokens') = 'number' THEN (r.usage_json ->> 'rawInputTokens')::numeric END,
           CASE WHEN jsonb_typeof(r.usage_json -> 'inputTokens') = 'number' THEN (r.usage_json ->> 'inputTokens')::numeric END, 0))) AS sample_input,
         greatest(0, floor(coalesce(
           CASE WHEN jsonb_typeof(r.usage_json -> 'rawCachedInputTokens') = 'number' THEN (r.usage_json ->> 'rawCachedInputTokens')::numeric END,
           CASE WHEN jsonb_typeof(r.usage_json -> 'cachedInputTokens') = 'number' THEN (r.usage_json ->> 'cachedInputTokens')::numeric END, 0))) AS sample_cached,
         greatest(0, floor(coalesce(
           CASE WHEN jsonb_typeof(r.usage_json -> 'rawOutputTokens') = 'number' THEN (r.usage_json ->> 'rawOutputTokens')::numeric END,
           CASE WHEN jsonb_typeof(r.usage_json -> 'outputTokens') = 'number' THEN (r.usage_json ->> 'outputTokens')::numeric END, 0))) AS sample_output
  FROM heartbeat_runs r
  JOIN agents a ON a.id = r.agent_id AND a.company_id = r.company_id
  CROSS JOIN parameters p
  WHERE r.company_id = p.company_id
    AND a.adapter_type IN ('codex_local', 'claude_local')
    AND r.created_at < p.window_end
    AND r.status IN ('succeeded', 'failed', 'timed_out', 'cancelled')
), valid_samples AS (
  -- A failed turn without usage is not a sample. The service skips it the same way (readLatestUsageSample).
  SELECT *, count(valid_input) OVER (
    PARTITION BY agent_id, session_id_after ORDER BY created_at, id
  ) AS valid_count
  FROM (
    SELECT *, CASE WHEN sample_input > 0 OR sample_cached > 0 OR sample_output > 0
                   THEN sample_input END AS valid_input
    FROM history
  ) sampled
), latest_valid AS (
  -- The latest valid sample at or before each run.
  SELECT *, first_value(valid_input) OVER (
    PARTITION BY agent_id, session_id_after, valid_count ORDER BY created_at, id
  ) AS latest_valid_input
  FROM valid_samples
), prior_totals AS (
  -- Include history before the window to measure its first resumed run.
  SELECT *, lag(latest_valid_input) OVER (
    PARTITION BY agent_id, session_id_after ORDER BY created_at, id
  ) AS previous_raw_input_tokens
  FROM latest_valid
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
