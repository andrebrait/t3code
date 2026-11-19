import * as Schema from "effect/Schema";

import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "./auth.ts";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestrationV2LinkedSender } from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const CLUSTER_SCOPES_HEADER = "x-t3-cluster-scopes";

const CLUSTER_ROUTE_PREFIX = "/cluster";

export const ClusterMemberStatus = Schema.Literals([
  "online",
  "offline",
  "incompatible",
  "revoked",
]);
export type ClusterMemberStatus = typeof ClusterMemberStatus.Type;

export const ClusterTransport = Schema.Literals(["https", "ssh"]);
export type ClusterTransport = typeof ClusterTransport.Type;

export const ClusterMember = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  transport: ClusterTransport,
  /** The member's https origin, or its ssh target such as `me@box:2222`. */
  address: Schema.String,
  status: ClusterMemberStatus,
  joinedAt: Schema.DateTimeUtc,
  lastReachedAt: Schema.NullOr(Schema.DateTimeUtc),
  lastError: Schema.NullOr(Schema.String),
});
export type ClusterMember = typeof ClusterMember.Type;

export const ClusterRole = Schema.Literals(["standalone", "main", "member"]);
export type ClusterRole = typeof ClusterRole.Type;

export const ClusterStatus = Schema.Struct({
  enabled: Schema.Boolean,
  role: ClusterRole,
  /** This server's certificate SHA-256, shown beside invites. */
  fingerprint: Schema.String,
  host: Schema.NullOr(
    Schema.Struct({
      environmentId: EnvironmentId,
      label: Schema.String,
      joinedAt: Schema.DateTimeUtc,
    }),
  ),
});
export type ClusterStatus = typeof ClusterStatus.Type;

export const ClusterInviteInput = Schema.Struct({
  /** Where the main host reaches this environment. Without it no join string is built. */
  url: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ClusterInviteInput = typeof ClusterInviteInput.Type;

export const ClusterInvite = Schema.Struct({
  code: TrimmedNonEmptyString,
  fingerprint: TrimmedNonEmptyString,
  joinString: Schema.NullOr(TrimmedNonEmptyString),
  expiresAt: Schema.DateTimeUtc,
});
export type ClusterInvite = typeof ClusterInvite.Type;

export const ClusterAddMemberInput = Schema.Struct({
  /** A join string from the member, or an ssh target (`user@host`, `ssh://user@host:port`). */
  target: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ClusterAddMemberInput = typeof ClusterAddMemberInput.Type;

export const ClusterMemberRef = Schema.Struct({ memberId: EnvironmentId });
export type ClusterMemberRef = typeof ClusterMemberRef.Type;

export const ClusterRenameMemberInput = Schema.Struct({
  memberId: EnvironmentId,
  label: TrimmedNonEmptyString,
});
export type ClusterRenameMemberInput = typeof ClusterRenameMemberInput.Type;

export const ClusterRemoveMemberResult = Schema.Struct({
  removed: Schema.Boolean,
  /** False when the member could not be told; `t3 cluster leave` there finishes it. */
  memberNotified: Schema.Boolean,
});
export type ClusterRemoveMemberResult = typeof ClusterRemoveMemberResult.Type;

export const ClusterLeaveResult = Schema.Struct({ left: Schema.Boolean });
export type ClusterLeaveResult = typeof ClusterLeaveResult.Type;

/** What a main host sends to a member's `POST /api/cluster/join`. */
export const ClusterJoinRequest = Schema.Struct({
  code: TrimmedNonEmptyString,
  host: Schema.Struct({ environmentId: EnvironmentId, label: TrimmedNonEmptyString }),
});
export type ClusterJoinRequest = typeof ClusterJoinRequest.Type;

export const ClusterJoinResult = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  /** The member's `cluster-host` session token. */
  token: TrimmedNonEmptyString,
});
export type ClusterJoinResult = typeof ClusterJoinResult.Type;

export class ClusterError extends Schema.TaggedError<ClusterError>()(
  "ClusterError",
  {
    reason: Schema.Literals([
      "disabled",
      "is_member",
      "is_main_host",
      "self",
      "unknown_member",
      "invalid_target",
      "certificate_changed",
      "unreachable",
      "incompatible",
      "pairing_rejected",
      "ssh",
      "storage",
      "forbidden",
      // The control link: a fetch or reply for a call nothing waits for.
      "unknown_request",
    ]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
  { httpApiStatus: 409 },
) {}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const JOIN_CODE = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`);

export const normalizeCertificateFingerprint = (value: string) =>
  value.replaceAll(":", "").toLowerCase();

export const formatClusterJoinString = (input: {
  readonly url: string;
  readonly code: string;
  readonly fingerprint: string;
}) =>
  `${new URL(input.url).origin}#${input.code}.${normalizeCertificateFingerprint(input.fingerprint)}`;

export const parseClusterJoinString = (value: string) => {
  const trimmed = value.trim();
  const hash = trimmed.lastIndexOf("#");
  if (hash < 0) return undefined;
  const url = URL.parse(trimmed.slice(0, hash));
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return undefined;
  const parts = trimmed.slice(hash + 1).split(".");
  if (parts.length !== 2) return undefined;
  const code = parts[0]!.toUpperCase();
  const fingerprint = parts[1]!.toLowerCase();
  if (!JOIN_CODE.test(code) || !SHA256_HEX.test(fingerprint)) return undefined;
  return { url: url.origin, code, fingerprint };
};

export interface ClusterSshTarget {
  readonly username: string | null;
  readonly hostname: string;
  readonly port: number | null;
}

export const parseClusterSshTarget = (value: string): ClusterSshTarget | undefined => {
  const match = /^(?:([^@\s/:]+)@)?([^@\s/:]+)(?::(\d{1,5}))?$/.exec(
    value.trim().replace(/^ssh:\/\//, ""),
  );
  if (match === null) return undefined;
  const port = match[3] === undefined ? null : Number(match[3]);
  if (port !== null && (port < 1 || port > 65_535)) return undefined;
  return { username: match[1] ?? null, hostname: match[2]!, port };
};

export const formatClusterSshTarget = (target: ClusterSshTarget) =>
  `${target.username === null ? "" : `${target.username}@`}${target.hostname}${
    target.port === null ? "" : `:${target.port}`
  }`;

export const clusterMemberBaseUrl = (hostBaseUrl: string, memberId: EnvironmentId) =>
  `${new URL(hostBaseUrl).origin}${CLUSTER_ROUTE_PREFIX}/${encodeURIComponent(memberId)}`;

/** One call a member's agent makes through its main host, which fetches it by `requestId`. */
export const ClusterHostRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  /** A T3 MCP tool; `arguments.environmentId` names the target unless it is the main host. */
  tool: TrimmedNonEmptyString,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  /** The calling agent's modes, which cap the call as `T3-Mode-Limit` does on `/mcp`. */
  limits: Schema.Struct({ runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode }),
  /** The member's thread the call is made for, as `T3-Sender-Thread` carries it. */
  sender: Schema.optionalKey(OrchestrationV2LinkedSender),
});
export type ClusterHostRequest = typeof ClusterHostRequest.Type;

/** `GET /api/cluster/events`: `ready` once the member listens, then a doorbell per call. */
export const ClusterLinkEvent = Schema.Union([
  Schema.TaggedStruct("ready", {}),
  Schema.TaggedStruct("request", { requestId: TrimmedNonEmptyString }),
]);
export type ClusterLinkEvent = typeof ClusterLinkEvent.Type;

/** A tool's answer as `/mcp` gives it: its joined text, and whether it is a refusal. */
export const ClusterHostResult = Schema.Struct({ isError: Schema.Boolean, text: Schema.String });
export type ClusterHostResult = typeof ClusterHostResult.Type;

/** The body of the main host's `POST /api/cluster/host-reply`: one call's answer. */
export const ClusterHostReplyInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  result: ClusterHostResult,
});
export type ClusterHostReplyInput = typeof ClusterHostReplyInput.Type;
