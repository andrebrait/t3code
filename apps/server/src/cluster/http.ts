import {
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { annotateEnvironmentRequest } from "../auth/http.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";
import * as ClusterService from "./ClusterService.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "cluster",
  Effect.fnUntraced(function* (handlers) {
    const cluster = yield* ClusterService.ClusterService;
    return handlers
      .handle(
        "join",
        Effect.fn("environment.cluster.join")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* cluster.acceptJoin(args.payload, deriveAuthClientMetadata({ request }));
        }),
      )
      .handle(
        "leave",
        Effect.fn("environment.cluster.leave")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          if (principal.subject !== EnvironmentAuth.CLUSTER_HOST_SUBJECT) {
            return yield* new EnvironmentHttpForbiddenError({
              message: "Only this environment's cluster host can remove it from the cluster.",
            });
          }
          return yield* cluster.leave;
        }),
      );
  }),
);
