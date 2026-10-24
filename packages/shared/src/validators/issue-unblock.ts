import { z } from "zod";
import { multilineTextSchema } from "./text.js";

export const reviewBridgeTargetSchema = z.object({
  waitId: z.string().guid(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  head: z.string().regex(/^[a-fA-F0-9]{40}$/).transform(value => value.toLowerCase()),
  pr: z.number().int().positive().optional(),
  stage: z.enum(["verdict", "merge_card", "lane_admission"]),
}).strict();

export const issueUnblockDescriptorSchema = z
    .object({
      owner: z.union([
        z.object({ agentId: z.string().guid() }).strict(),
        z.object({ userId: z.string().trim().min(1) }).strict(),
        z.literal("board"),
      ]),
      action: multilineTextSchema.pipe(z.string().trim().min(1).max(2_000)),
      kind: z.enum(["external", "human", "date", "review_bridge"]).optional(),
      until: z.iso.datetime().optional(),
      bridge: reviewBridgeTargetSchema.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.kind === "review_bridge") {
        if (!value.until || !value.bridge) {
          ctx.addIssue({ code: "custom", message: "A bridge wait requires until and bridge", path: ["bridge"] });
        }
      } else if (value.bridge) {
        ctx.addIssue({ code: "custom", message: "bridge requires review_bridge kind", path: ["bridge"] });
      }
    })
    .optional()
    .nullable();
