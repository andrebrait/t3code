// Hop-by-hop headers (RFC 9110 §7.6.1) describe one connection; undici refuses some outright.
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

const DROPPED_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP,
  "expect",
  "host",
  "content-length",
  "accept-encoding",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  // The proxy authenticates the client; its credentials never reach the upstream.
  "cookie",
  "authorization",
  "dpop",
  // A loopback upstream trusts these; the client's HTTPS hop would also fail upstream Origin checks.
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

// An upstream must not set cookies or origin-wide policy here; CORS is this server's. Its CSP stays:
// it only restricts that response, and agent HTML depends on its sandbox.
const DROPPED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP,
  "content-encoding",
  "set-cookie",
  "clear-site-data",
  "strict-transport-security",
]);

const keep = (
  headers: Readonly<Record<string, string | undefined>>,
  dropped: (name: string) => boolean,
) => {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !dropped(name)) kept[name] = value;
  }
  return kept;
};

/** A client request's headers that are safe to send on to an upstream. */
export const forwardedRequestHeaders = (headers: Readonly<Record<string, string | undefined>>) =>
  keep(headers, (name) => DROPPED_REQUEST_HEADERS.has(name));

/** An upstream response's headers that are safe to answer the client with. */
export const forwardedResponseHeaders = (headers: Readonly<Record<string, string | undefined>>) =>
  keep(headers, (name) => DROPPED_RESPONSE_HEADERS.has(name) || name.startsWith("access-control-"));
