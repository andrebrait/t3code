import { useAtomValue } from "@effect/atom-react";
import { AuthAccessWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";

import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

export function NetworkPlainHttpRow(props: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canWriteAccess = useEnvironmentScope(props.environmentId, AuthAccessWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "environment settings update",
    reportFailure: true,
  });
  const policy = serverConfig?.settings.networkPlainHttp;
  if (policy === undefined) return null;
  return (
    <ListToggleRow
      label={gt("Redirect network HTTP to HTTPS")}
      description={gt(
        "Browsers on your network switch to HTTPS, and apps on your network must use it. This device, Tailscale, and T3 Connect are unaffected.",
      )}
      value={policy === "redirect"}
      disabled={!canWriteAccess}
      onValueChange={(enabled) => {
        void updateSettings({
          environmentId: props.environmentId,
          input: { patch: { networkPlainHttp: enabled ? "redirect" : "allow" } },
        });
      }}
    />
  );
}
