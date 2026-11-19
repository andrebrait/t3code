export * from "@t3tools/shared/advertisedEndpoint";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  // A cluster member's base carries its main host's `/cluster/<id>` prefix.
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${pathname}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};
