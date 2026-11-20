import {
  ClusterError,
  type ClusterMember,
  type ClusterSshLogin,
  ClusterInvite,
  ClusterRemoveMemberResult,
  EnvironmentId,
  ClusterMember as ClusterMemberSchema,
  ClusterStatus,
} from "@t3tools/contracts";
import * as SshAuth from "@t3tools/ssh/auth";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ClusterService from "../cluster/ClusterService.ts";
import * as ClusterSshKey from "../cluster/ClusterSshKey.ts";
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
      // Kept like the server's: the CLI exiting must not stop the member it just added.
      Layer.provide(ClusterSshKey.layerSshManager),
      Layer.provide(SshAuth.SshPasswordPrompt.disabledLayer),
    ),
  ),
  Layer.provide(ClusterSshKey.layer),
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
const encodeRemoveJson = Schema.encodeSync(Schema.fromJsonString(ClusterRemoveMemberResult));
const encodeList = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ status: ClusterStatus, members: Schema.Array(ClusterMemberSchema) }),
  ),
);

const formatList = (status: ClusterStatus, members: ReadonlyArray<ClusterMember>) =>
  status.host !== null
    ? `Member of the cluster hosted by ${status.host.label} (${status.host.environmentId}).`
    : members.length === 0
      ? "Standalone: this environment has no cluster members."
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
          .join("\n")}`;

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
                    ? `Join string (expires ${DateTime.formatIso(invite.expiresAt)}):\n${invite.joinString}`
                    : `Code: ${invite.code}\nCertificate SHA-256: ${invite.fingerprint}\nPass --url to print a join string.`,
              ),
            ),
          ),
      { quietLogs: flags.json },
    ),
  ),
);

// Secrets come only from stdin, never argv, which other users on this machine can read.
const readStdinSecret = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const text = yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString);
  return Redacted.make(text.replace(/\r?\n$/, ""));
}).pipe(
  Effect.mapError(
    (cause) => new ClusterError({ reason: "ssh", message: "Could not read stdin.", cause }),
  ),
);

const sshLogin = (flags: {
  readonly passwordStdin: boolean;
  readonly key: Option.Option<string>;
  readonly passphraseStdin: boolean;
}): Effect.Effect<ClusterSshLogin | undefined, ClusterError, Stdio.Stdio> => {
  if (flags.passwordStdin && Option.isSome(flags.key)) {
    return Effect.fail(
      new ClusterError({
        reason: "invalid_target",
        message: "Pass --password-stdin or --key, not both.",
      }),
    );
  }
  if (flags.passphraseStdin && Option.isNone(flags.key)) {
    return Effect.fail(
      new ClusterError({ reason: "invalid_target", message: "--passphrase-stdin needs --key." }),
    );
  }
  if (flags.passwordStdin) {
    return readStdinSecret.pipe(
      Effect.map((password) => ({ _tag: "password", password }) as const),
    );
  }
  if (Option.isNone(flags.key)) return Effect.undefined;
  const path = flags.key.value;
  return flags.passphraseStdin
    ? readStdinSecret.pipe(
        Effect.map((passphrase) => ({ _tag: "keyFile", path, passphrase }) as const),
      )
    : Effect.succeed({ _tag: "keyFile", path });
};

const addCommand = Command.make("add", {
  ...authLocationFlags,
  target: Argument.String("target").pipe(
    Argument.withDescription("The member's join string, or an ssh target such as ssh://me@box."),
  ),
  label: Flag.String("label").pipe(Flag.withDescription("What to call the member."), Flag.optional),
  passwordStdin: Flag.Boolean("password-stdin").pipe(
    Flag.withDescription("Sign in to an ssh target once with the password read from stdin."),
    Flag.withDefault(false),
  ),
  key: Flag.String("key").pipe(
    Flag.withDescription("Sign in to an ssh target once with this private key file."),
    Flag.optional,
  ),
  passphraseStdin: Flag.Boolean("passphrase-stdin").pipe(
    Flag.withDescription("Read the --key file's passphrase from stdin."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Add an environment to this machine's cluster. Over ssh, this machine signs in once and installs its own cluster key there.",
  ),
  Command.withHandler((flags) =>
    sshLogin(flags).pipe(
      Effect.flatMap((login) =>
        runWithCluster(flags, (cluster) =>
          cluster
            .addMember({
              target: flags.target,
              ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
              ...(login === undefined ? {} : { login }),
            })
            .pipe(
              Effect.flatMap((member) =>
                Console.log(
                  `Added ${member.label} (${member.environmentId}) over ${member.transport}.${
                    member.transport === "ssh"
                      ? " Installed this machine's cluster key in ~/.ssh/authorized_keys there."
                      : ""
                  }`,
                ),
              ),
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
              ? "Left the cluster. Pair clients with this environment as usual."
              : "This environment is not a member of a cluster.",
          ),
        ),
      ),
    ),
  ),
);

const removeCommand = Command.make("remove", {
  ...authLocationFlags,
  environmentId: Argument.String("environmentId").pipe(
    Argument.withDescription("The member's environment id, as shown by `t3 cluster list`."),
    Argument.withSchema(EnvironmentId),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Remove a member from this machine's cluster."),
  Command.withHandler((flags) =>
    runWithCluster(
      flags,
      (cluster) =>
        cluster
          .removeMember(flags.environmentId)
          .pipe(
            Effect.flatMap((result) =>
              Console.log(
                flags.json
                  ? encodeRemoveJson(result)
                  : !result.removed
                    ? "No such member."
                    : `${
                        result.memberNotified
                          ? "Removed the member."
                          : "Removed the member, but it could not be told. Run `t3 cluster leave` there to finish."
                      }${
                        result.keyRevoked === null
                          ? ""
                          : result.keyRevoked
                            ? " Removed this machine's cluster key there."
                            : " Its cluster key could not be removed there: delete the t3code-cluster line in ~/.ssh/authorized_keys by hand."
                      }`,
              ),
            ),
          ),
      { quietLogs: flags.json },
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
  Command.withSubcommands([inviteCommand, addCommand, leaveCommand, removeCommand, listCommand]),
);
