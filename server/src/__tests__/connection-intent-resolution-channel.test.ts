import { describe, expect, it, vi } from "vitest";
import { connectionIntentOAuthFinisher } from "../routes/connection-intent-oauth-resolution.js";

describe("OAuth connection-intent resolution attribution", () => {
  it.each([["session", "user_session"], ["board_key", "board_api_key"]] as const)(
    "forwards the authenticated %s channel", async (source, resolvedVia) => {
      const complete = vi.fn().mockResolvedValue({ status: "accepted", resolvedVia });
      const updatePhase = vi.fn();
      const deliver = vi.fn();
      const finish = connectionIntentOAuthFinisher({
        loadIntent: vi.fn().mockResolvedValue({ interaction: { status: "pending", addresseeUserId: "user" } }),
        complete, updatePhase,
      }, deliver);
      const result = await finish({
        interactionId: "card", connectionId: "connection", userId: "user",
        actor: { type: "board", source, userId: "user" }, outcome: "connected",
        canManageOrganizationGrant: false, bypassCurrentMembershipCheck: false,
      });
      expect(complete).toHaveBeenCalledWith("card", "connection", "user", {
        canManageOrganizationGrant: false, bypassCurrentMembershipCheck: false, resolvedVia,
      });
      expect(result.resolvedVia).toBe(resolvedVia);
      expect(updatePhase).not.toHaveBeenCalled();
      expect(deliver).toHaveBeenCalledWith("card");
    },
  );
});
