import { questionResponseDeliveryService } from "./question-response-delivery.js";
import { interactionResolutionOutboxService } from "./interaction-resolution-outbox.js";

/** Use the existing startup and periodic delivery sweeps for both outboxes. */
export function interactionDeliveryService(...args: Parameters<typeof questionResponseDeliveryService>) {
  const questions = questionResponseDeliveryService(...args);
  const resolutions = interactionResolutionOutboxService(args[0], args[1].heartbeat, { now: args[1].now });
  return { ...questions, sweepPending: async (limit?: number) => {
    await resolutions.sweepPending(limit);
    return questions.sweepPending(limit);
  } };
}
