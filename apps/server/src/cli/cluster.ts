import {
  type ClusterMember,
  ClusterInvite,
  ClusterMember as ClusterMemberSchema,
  ClusterStatus,
} from "@t3tools/contracts";
import * as SshAuth from "@t3tools/ssh/auth";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ClusterService from "../cluster/ClusterService.ts";
import * as ClusterUpstream from "../cluster/ClusterUpstream.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerTls from "../tls/ServerTls.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

const layerClusterCli = ClusterService.layer.pipe(
  Layer.provide(
    ClusterUpstream.layer.pipe(
      Layer.provide(SshTunnel.SshEnvironmentManager.layer()),
      Layer.provide(SshAuth.SshPasswordPrompt.disabledLayer),
    ),
  ),
  Layer.provide(PeerLinks.layer),
  Layer.provide(ServerTls.layer),
  Layer.provideMerge(ServerSettings.layer.pipe(Layer.provide(ManagedPolicy.layer))),
  Layer.provideMerge(ServerEnvironment.layer),
  Layer.provideMerge(EnvironmentAuth.layerRuntime),
  Layer.provide(FetchHttpClient.layer),
);

const runWithCluster = Effect.fn("cluster.runWithCluster")(function* <A, E>(
  flags: CliAuthLocationFlags,
  run: (cluster: ClusterService.ClusterService["Service"]) => Effect.Effect<A, E>,
  options?: { readonly quietLogs?: boolean },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, options);
  const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
  return yield* ClusterService.ClusterService.pipe(
    Effect.flatMap(run),
    Effect.provide(
      layerClusterCli.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const encodeInviteJson = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      credential: ClusterInvite.fields.code,
      fingerprint: ClusterInvite.fields.fingerprint,
      joinString: ClusterInvite.fields.joinString,
      expiresAt: ClusterInvite.fields.expiresAt,
    }),
  ),
);
const encodeList = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ status: ClusterStatus, members: Schema.Array(ClusterMemberSchema) }),
  ),
);

const formatList = (status: ClusterStatus, members: ReadonlyArray<ClusterMember>) =>
  status.host !== null
    ? `Member of the cluster hosted by ${status.host.label} (${status.host.environmentId}).\n`
    : members.length === 0
      ? "Standalone: this environment has no cluster members.\n"
      : `${members
          .map((member) =>
            [
              member.label,
              member.environmentId,
              member.transport,
              member.address,
              member.status,
              member.lastError ?? "",
            ]
              .join("\t")
              .trimEnd(),
          )
          .join("\n")}\n`;

const inviteCommand = Command.make("invite", {
  ...authLocationFlags,
  url: Flag.String("url").pipe(
    Flag.withDescription(
      "Where the main host reaches this environment, such as https://box.local:3773. Prints a join string.",
    ),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Mint a one-time code that lets a main host add this environment to its cluster.",
  ),
  Command.withHandler((flags) =>
    runWithCluster(
      flags,
      (cluster) =>
        cluster
          .invite(Option.isSome(flags.url) ? { url: flags.url.value } : {})
          .pipe(
            Effect.flatMap((invite) =>
              Console.log(
                flags.json
                  ? encodeInviteJson({ ...invite, credential: invite.code })
                  : invite.joinString !== null
                    ? `Join string (expires ${DateTime.formatIso(invite.expiresAt)}):\n${invite.joinString}\n`
                    : `Code: ${invite.code}\nCertificate SHA-256: ${invite.fingerprint}\nPass --url to print a join string.\n`,
              ),
            ),
          ),
      { quietLogs: flags.json },
    ),
  ),
);

const addCommand = Command.make("add", {
  ...authLocationFlags,
  target: Argument.String("target").pipe(
    Argument.withDescription("The member's join string, or an ssh target such as ssh://me@box."),
  ),
  label: Flag.String("label").pipe(Flag.withDescription("What to call the member."), Flag.optional),
}).pipe(
  Command.withDescription("Add an environment to this machine's cluster."),
  Command.withHandler((flags) =>
    runWithCluster(flags, (cluster) =>
      cluster
        .addMember({
          target: flags.target,
          ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
        })
        .pipe(
          Effect.flatMap((member) =>
            Console.log(
              `Added ${member.label} (${member.environmentId}) over ${member.transport}.\n`,
            ),
          ),
        ),
    ),
  ),
);

const leaveCommand = Command.make("leave", { ...authLocationFlags }).pipe(
  Command.withDescription("Leave this environment's cluster and become standalone again."),
  Command.withHandler((flags) =>
    runWithCluster(flags, (cluster) =>
      cluster.leave.pipe(
        Effect.flatMap(({ left }) =>
          Console.log(
            left
              ? "Left the cluster. Pair clients with this environment as usual.\n"
              : "This environment is not a member of a cluster.\n",
          ),
        ),
      ),
    ),
  ),
);

const listCommand = Command.make("list", { ...authLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("Show this environment's cluster and its members."),
  Command.withHandler((flags) =>
    runWithCluster(
      flags,
      (cluster) =>
        Effect.gen(function* () {
          const status = yield* cluster.status;
          const members = Option.getOrElse(yield* Stream.runHead(cluster.members), () => []);
          yield* Console.log(
            flags.json ? encodeList({ status, members }) : formatList(status, members),
          );
        }),
      { quietLogs: flags.json },
    ),
  ),
);

export const clusterCommand = Command.make("cluster").pipe(
  Command.withDescription("Group environments under one main host."),
  Command.withSubcommands([inviteCommand, addCommand, leaveCommand, listCommand]),
);
