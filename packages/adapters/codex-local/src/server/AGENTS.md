# Codex exec usage

`turn.completed.usage` contains cumulative thread totals, including on resume.
Subtract the last valid sample for the same provider session before applying a per-run input cap.
Repeated totals add zero. A counter reset starts a new segment.
The exec protocol reports usage after the agentic turn. It provides no per-tool admission hook.
Use the normal process exit as the stop boundary. Do not signal a tool or a write to enforce this soft cap.
