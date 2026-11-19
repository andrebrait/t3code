import type { NetworkPlainHttp } from "@t3tools/contracts";
import {
  isLocalLoopbackHost,
  isSharedAddressSpaceHost,
  isTailnetHost,
} from "@t3tools/shared/hostClassification";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";

export type PlainHttpDecision =
  | { readonly _tag: "pass" }
  | { readonly _tag: "redirect"; readonly location: string }
  | { readonly _tag: "httpsRequired" };

// The socket peer, not a header: loopback carries T3 Connect, Tailscale Serve, SSH forwards, and the desktop renderer.
const isExemptPeer = (remoteAddress: string | undefined): boolean => {
  if (remoteAddress === undefined) return false;
  const address = remoteAddress.replace(/^::ffff:/i, "");
  return (
    isLocalLoopbackHost(address) || isTailnetHost(address) || isSharedAddressSpaceHost(address)
  );
};

export const plainHttpDecision = (input: {
  readonly policy: NetworkPlainHttp;
  readonly encrypted: boolean;
  readonly remoteAddress: string | undefined;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}): PlainHttpDecision => {
  if (input.policy === "allow" || input.encrypted || isExemptPeer(input.remoteAddress)) {
    return { _tag: "pass" };
  }
  const { headers } = input;
  const navigation =
    (input.method === "GET" || input.method === "HEAD") &&
    headers.upgrade === undefined &&
    headers.host !== undefined &&
    /^[\w.\-:[\]]+$/.test(headers.host) &&
    (headers["sec-fetch-mode"] === "navigate" || (headers.accept ?? "").includes("text/html"));
  return navigation
    ? { _tag: "redirect", location: `https://${headers.host}${input.url}` }
    : { _tag: "httpsRequired" };
};

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    return HttpRouter.middleware(
      (httpEffect) =>
        Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
          const socket = (
            request.source as {
              readonly socket?: { readonly encrypted?: boolean; readonly remoteAddress?: string };
            }
          ).socket;
          const decide = (policy: NetworkPlainHttp) =>
            plainHttpDecision({
              policy,
              encrypted: socket?.encrypted === true,
              remoteAddress: socket?.remoteAddress,
              method: request.method,
              url: request.url,
              headers: request.headers,
            });
          // Encrypted and exempt peers never depend on a settings read that could fail.
          if (decide("redirect")._tag === "pass") return httpEffect;
          return settings.getSettings.pipe(
            Effect.map((current) => current.networkPlainHttp),
            Effect.catch((cause) =>
              Effect.logWarning("plain HTTP policy: settings unreadable, allowing", { cause }).pipe(
                Effect.as<NetworkPlainHttp>("allow"),
              ),
            ),
            Effect.flatMap((policy) => {
              const decision = decide(policy);
              if (decision._tag === "pass") return httpEffect;
              return Effect.succeed(
                decision._tag === "redirect"
                  ? HttpServerResponse.redirect(decision.location, { status: 308 })
                  : HttpServerResponse.jsonUnsafe({ code: "https_required" }, { status: 426 }),
              );
            }),
          );
        }),
      { global: true },
    );
  }),
);
