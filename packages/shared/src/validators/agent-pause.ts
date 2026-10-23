import { z } from "zod";

export const pauseAgentSchema = z.object({
  reason: z.string()
    .max(128)
    .regex(/^ops-guard:[A-Za-z0-9][A-Za-z0-9._:-]*$/)
    .transform((reason) => reason as `ops-guard:${string}`)
    .optional(),
}).default({});

export type PauseAgent = z.infer<typeof pauseAgentSchema>;
