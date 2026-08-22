import type { PeerMessage } from "@mlpal/harness-protocol";
import type { Store } from "../store/types";

/** Appended to a handoff request (a correlationId-tagged peer message) so the receiving agent
 *  knows to end with a report — which is auto-sent back on its private reply channel. */
export const HANDOFF_FRAME =
  "\n\n[This is a handoff request from another repo's agent. Complete it here, then end with a " +
  "short report of what you changed — it is sent back automatically.]";

/** Frame a drained peer message for injection: handoff requests get the report-back instruction;
 *  plain steering messages (no correlationId) pass through unchanged. */
export function frameHandoff(pm: PeerMessage): string {
  return pm.correlationId ? `${pm.text}${HANDOFF_FRAME}` : pm.text;
}

/** Post a handoff reply on its private correlationId channel so the caller (blocked in
 *  HandoffTask) unblocks. Deterministic — the model doesn't have to remember to reply. */
export async function postHandoffReply(
  store: Store,
  agentId: string,
  correlationId: string,
  text: string,
): Promise<void> {
  await store.mailbox.post(correlationId, {
    type: "peer_message",
    from: { type: "agent", id: agentId },
    toSession: correlationId,
    text: text || "(the other agent finished but produced no summary)",
    correlationId,
  });
}
