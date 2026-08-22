import type { Author } from "./author";

/**
 * Control channel: permission round-trips and peer-message injection ride here.
 * Phase 0 wires permission; peer messages are defined now so the inter-agent
 * layer (docs/05 §7) plugs into a stable contract later.
 */

export interface PermissionRequest {
  type: "permission_request";
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  author: Author;
}

export interface PermissionResponse {
  type: "permission_response";
  id: string;
  decision: "allow" | "deny";
  reason?: string;
}

export interface PeerMessage {
  type: "peer_message";
  from: Author;
  toSession: string;
  text: string;
  correlationId?: string;
}

export type ControlRequest = PermissionRequest;
export type ControlResponse = PermissionResponse;
