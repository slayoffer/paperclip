import { z } from "zod";

export const RUN_STATS_MAX_RANGE_MS = 14 * 24 * 60 * 60 * 1000;
export const runStatsQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  bucket: z.literal("hour").default("hour"),
  groupBy: z.enum(["status", "errorCode", "agentId"]).default("status"),
  errorCode: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,95}$/).optional(),
}).strict().refine((query) => {
  const duration = Date.parse(query.to) - Date.parse(query.from);
  return duration > 0 && duration <= RUN_STATS_MAX_RANGE_MS;
}, { message: "Use a positive range of at most 14 days." });

export type RunStatsQuery = z.infer<typeof runStatsQuerySchema>;
export interface RunStatsCount {
  bucket: string;
  group: string | null;
  count: number;
  matchingCount: number | null;
}
export interface RunStatsReport extends RunStatsQuery {
  companyId: string;
  total: number;
  matchingTotal: number | null;
  rows: RunStatsCount[];
}
