import type { ActorInfo } from "../types.js";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolOauthStates } from "@paperclipai/db";
import { badRequest, forbidden } from "../../../errors.js";

import { actorBinding } from "../actor.js";
import { recordOAuthCardOutcome, tryProjectOAuthCardOutcome } from "./card-projection.js";
function oauthActorType(value: string | null): ActorInfo["actorType"] | null {
  return value === "agent" ||
    value === "user" ||
    value === "system" ||
    value === "plugin"
    ? value
    : null;
}

function assertSameOAuthActor(
  stateRow: typeof toolOauthStates.$inferSelect,
  actor: ActorInfo | undefined,
) {
  const expected = {
    actorType: oauthActorType(stateRow.createdByActorType),
    actorId: stateRow.createdByActorId,
    sessionId: stateRow.createdBySessionId,
  };
  const actual = actorBinding(actor);
  if (!expected.actorType || !expected.actorId) {
    throw forbidden(
      "OAuth sign-in state is not bound to an authenticated board session",
    );
  }
  if (
    expected.actorType !== actual.actorType ||
    expected.actorId !== actual.actorId
  ) {
    throw forbidden(
      "OAuth sign-in must be completed by the user who started it",
    );
  }
  if (expected.sessionId && expected.sessionId !== actual.sessionId) {
    throw forbidden(
      "OAuth sign-in must be completed from the same authenticated session",
    );
  }
}

export function createOAuthStateStore(db: Db) {
  async function peekOAuthState(state: string) {
    const [row] = await db
      .select({
        companyId: toolOauthStates.companyId,
        connectionId: toolOauthStates.connectionId,
        subjectUserId: toolOauthStates.subjectUserId,
        subjectAgentId: toolOauthStates.subjectAgentId,
        returnTo: toolOauthStates.returnTo,
        issueId: toolOauthStates.issueId,
        interactionId: toolOauthStates.interactionId,
      })
      .from(toolOauthStates)
      .where(eq(toolOauthStates.state, state))
      .limit(1);
    return row ?? null;
  }

  /** Bind a callback to its initiating actor without consuming retryable state. */
  async function validateOAuthState(
    state: string,
    actor: ActorInfo | undefined,
    query: Pick<Db, "select"> = db,
  ) {
    const [stateRow] = await query
      .select()
      .from(toolOauthStates)
      .where(eq(toolOauthStates.state, state))
      .limit(1);
    if (!stateRow)
      throw badRequest("OAuth state was not found or has already been used");
    if (stateRow.expiresAt.getTime() <= Date.now())
      throw badRequest("OAuth state has expired");
    if (stateRow.subjectUserId) {
      if (
        actor?.actorType !== "user" ||
        actor.actorId !== stateRow.subjectUserId
      ) {
        throw forbidden(
          "OAuth callback user does not match the requested subject",
        );
      }
    } else {
      assertSameOAuthActor(stateRow, actor);
    }
    return stateRow;
  }

  /**
   * Answer a terminal authorization callback exactly once. Actor validation
   * happens before the atomic delete, so an unbound callback cannot consume a
   * valid flow and concurrent callbacks cannot both complete it.
   */
  async function consumeOAuthState(
    state: string,
    actor: ActorInfo | undefined,
    query: Pick<Db, "select" | "delete"> = db,
  ) {
    await validateOAuthState(state, actor, query);
    const [consumed] = await query
      .delete(toolOauthStates)
      .where(and(eq(toolOauthStates.state, state), gt(toolOauthStates.expiresAt, new Date())))
      .returning();
    if (!consumed)
      throw badRequest("OAuth state was not found or has already been used");
    return consumed;
  }

  /** Persist the denial before the callback returns an error to the caller. */
  async function rejectPendingOAuthInteraction(
    state: string | typeof toolOauthStates.$inferSelect,
    actor: ActorInfo | undefined,
    expectedVerifier?: string,
  ) {
    const consumed = await db.transaction(async tx => {
      const stateRow = typeof state === "string" ? await consumeOAuthState(state, actor, tx) : state;
      if (expectedVerifier && stateRow.codeVerifier !== expectedVerifier) {
        throw badRequest("OAuth state does not belong to a Vercel Connect flow");
      }
      await recordOAuthCardOutcome(tx, stateRow, "rejected", actor);
      return stateRow;
    });
    await tryProjectOAuthCardOutcome(db, consumed);
  }

  return { peekOAuthState, validateOAuthState, consumeOAuthState, rejectPendingOAuthInteraction };
}
export type OAuthStateStore = ReturnType<typeof createOAuthStateStore>;
