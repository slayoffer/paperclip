import { describe, expect, it, vi } from "vitest";
import { connectionIntentOAuthFinisher } from "../routes/connection-intent-oauth-resolution.js";

describe("OAuth connection-intent resolution attribution", () => {
  it("leaves provider callback provenance unknown", async () => {
      const complete = vi.fn().mockResolvedValue({ status: "accepted", resolvedVia: null });
      const updatePhase = vi.fn();
      const deliver = vi.fn();
      const finish = connectionIntentOAuthFinisher({
        loadIntent: vi.fn().mockResolvedValue({ interaction: { status: "pending", addresseeUserId: "user" } }),
        complete, updatePhase,
      }, deliver);
      const result = await finish({
        interactionId: "card", connectionId: "connection", userId: "user",
        outcome: "connected",
        canManageOrganizationGrant: false, bypassCurrentMembershipCheck: false,
      });
      expect(complete).toHaveBeenCalledWith("card", "connection", "user", {
        canManageOrganizationGrant: false, bypassCurrentMembershipCheck: false, via: null,
      });
      expect(result.resolvedVia).toBeNull();
      expect(updatePhase).not.toHaveBeenCalled();
      expect(deliver).toHaveBeenCalledWith("card");
  });
});
