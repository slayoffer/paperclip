import { z } from "zod";
import { multilineTextSchema } from "./text.js";

export const issueUnblockDescriptorSchema = z
    .object({
      owner: z.union([
        z.object({ agentId: z.string().guid() }).strict(),
        z.object({ userId: z.string().trim().min(1) }).strict(),
        z.literal("board"),
      ]),
      action: multilineTextSchema.pipe(z.string().trim().min(1).max(2_000)),
      kind: z.enum(["external", "human", "date"]).optional(),
      until: z.iso.datetime().optional(),
    })
    .strict()
    .optional()
    .nullable();
