import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  isLinkedThreadWorking,
  linkedThreadFailure,
  type LinkedThreadFailure,
  type LinkedThreadItemPresentation,
  type LinkedThreadTarget,
  presentLinkedThreadItem,
} from "@t3tools/client-runtime/linked-thread";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import type * as React from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useEnvironments } from "../../state/environments";
import { useConnectLinkedEnvironment, useLinkedThreadSession } from "../../state/linkedThread";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import type { LinkedThreadRouteParams } from "./linkedThreadRoute";
import { ReadOnlyComposerBar } from "./ReadOnlyComposerBar";
import { ThreadInspectorHeader, type ThreadInspectorPresentation } from "./thread-inspector-header";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

function TruncatedNote() {
  return (
    <Text className="mt-1 text-xs text-foreground-muted">
      <T>Long text, cut short here.</T>
    </Text>
  );
}

function ActivityRow(props: {
  readonly item: Extract<LinkedThreadItemPresentation, { kind: "activity" }>;
}) {
  const { item } = props;
  const [open, setOpen] = useState(false);
  const summary = (
    <Text
      numberOfLines={open ? undefined : 1}
      className={`font-mono text-xs ${item.failed ? "text-danger-foreground" : "text-foreground-muted"}`}
    >
      {item.summary}
    </Text>
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={() => setOpen(!open)}
      className="active:opacity-70"
    >
      {summary}
      {open && item.body !== null ? (
        <View className="mt-1 rounded-lg bg-subtle p-2">
          <Text selectable className="font-mono text-xs text-foreground-muted">
            {item.body}
          </Text>
          {item.truncated ? <TruncatedNote /> : null}
        </View>
      ) : null}
    </Pressable>
  );
}

function LinkedThreadItem(props: { readonly item: LinkedThreadItemPresentation }) {
  const { item } = props;
  const styles = useMarkdownPreviewStyles();
  if (item.kind === "activity") return <ActivityRow item={item} />;
  return item.kind === "user" ? (
    <View className="max-w-[88%] self-end rounded-2xl bg-user-bubble px-3.5 py-2.5">
      <Text selectable className="text-sm text-user-bubble-foreground">
        {item.text}
      </Text>
      {item.truncated ? <TruncatedNote /> : null}
    </View>
  ) : (
    <View>
      <SelectableMarkdownText markdown={item.text} textStyle={styles.nativeTextStyle} />
      {item.truncated ? <TruncatedNote /> : null}
    </View>
  );
}

function FailureCard(props: {
  readonly failure: LinkedThreadFailure;
  readonly stale: boolean;
  readonly onRetry: () => void;
}) {
  const gt = useGT();
  return (
    <View
      accessibilityLiveRegion="polite"
      className="gap-1 rounded-2xl border border-danger-border bg-danger px-3.5 py-3"
    >
      <Text className="font-t3-medium text-sm text-danger-foreground">{props.failure.title}</Text>
      <Text className="text-sm text-danger-foreground">
        {props.failure.detail}
        {props.stale ? ` ${gt("Showing what was read before.")}` : ""}
      </Text>
      {props.failure.retryable ? (
        <View className="mt-2 self-start">
          <Button size="compact" tone="secondary" label={gt("Try again")} onPress={props.onRetry} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * Stands where a composer would: the thread takes no messages from here. `action` is the one way
 * forward it offers, and `notice` what came of it.
 */
function LinkedThreadComposer(props: {
  /** The linked environment the thread is on. */
  readonly label: string;
  /** The environment that reads it. */
  readonly via: string;
  readonly working: boolean;
  readonly action?: React.ReactNode;
  readonly notice?: React.ReactNode;
}) {
  const { label, via } = props;
  const gt = useGT();
  return (
    <>
      {props.notice}
      <ReadOnlyComposerBar>
        <View accessible className="min-w-0 flex-1 gap-0.5">
          <Text numberOfLines={1} className="font-t3-bold text-sm text-foreground">
            <T>Read-only</T>
          </Text>
          <Text numberOfLines={1} className="font-sans text-xs text-foreground-secondary">
            {props.working
              ? gt("On {label} via {via} · Working", { label, via })
              : gt("On {label} via {via}", { label, via })}
          </Text>
        </View>
        {props.action}
      </ReadOnlyComposerBar>
    </>
  );
}

/**
 * A linked environment's thread, read through the environment this app is connected to. The app
 * never connects to the linked one, so the view only reads. It shows in the inspector, where
 * `presentation` maximizes it, or as its own screen, where `presentation` closes it.
 */
export function LinkedThreadView(props: {
  readonly target: LinkedThreadTarget;
  /** Closes the screen by going back when absent. */
  readonly presentation?: ThreadInspectorPresentation;
}) {
  const { target } = props;
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const presentation = props.presentation ?? { onClose: () => navigation.goBack() };
  const inInspector = "onMaximize" in presentation;
  const insets = useSafeAreaInsets();
  const via =
    useEnvironments().environments.find(
      (environment) => environment.environmentId === target.viaEnvironmentId,
    )?.label ?? gt("this environment");
  const { state, session } = useLinkedThreadSession(target, () => navigation.isFocused());
  const { transcript } = state;
  const label = transcript?.label ?? target.label;
  const failure = state.error === null ? null : linkedThreadFailure(state.error, { via, label }, m);
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  // Follows new items only while the reader is already at the end.
  const atEnd = useRef(true);
  const working = transcript !== null && isLinkedThreadWorking(transcript);
  const connection = useConnectLinkedEnvironment(target);
  const connectState = connection.state;
  const openThread = useOpenLinkedThread();
  const connect = async () => {
    const outcome = await connection.connect();
    if (outcome.type === "unreachable") return;
    // The read-only view gives way either way: the thread opens where the app is now connected,
    // or the add-environment screen takes its place. In the inspector the thread replaces it there.
    if (outcome.type === "connected") {
      if (!inInspector) navigation.goBack();
      openThread({ environmentId: target.environmentId, threadId: target.threadId });
      return;
    }
    if (inInspector) navigation.navigate("ConnectionsNew", { linked: target.environmentId });
    else {
      navigation.dispatch(StackActions.replace("ConnectionsNew", { linked: target.environmentId }));
    }
  };
  return (
    <View collapsable={false} className={inInspector ? "flex-1 bg-screen" : "flex-1 bg-sheet"}>
      <ThreadInspectorHeader
        {...presentation}
        title={transcript?.thread.title || target.title || gt("Thread on {label}", { label })}
      />
      <ScreenContent>
        <ScrollView
          ref={scroll}
          nestedScrollEnabled
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-3 px-5 pb-3 pt-3"
          // An earlier page lands above what is being read without moving it.
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          scrollEventThrottle={64}
          onScroll={({ nativeEvent }) => {
            const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
            atEnd.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 80;
          }}
          onContentSizeChange={() => {
            if (atEnd.current) scroll.current?.scrollToEnd({ animated: false });
          }}
        >
          {transcript === null ? (
            failure === null ? (
              <View className="flex-row items-center gap-2 pt-6">
                <AppActivityIndicator size="small" />
                <Text className="text-sm text-foreground-muted">
                  {gt("Reading from {label}…", { label })}
                </Text>
              </View>
            ) : (
              <FailureCard failure={failure} stale={false} onRetry={session.retry} />
            )
          ) : (
            <>
              {transcript.earlierPosition !== null ? (
                <View className="self-center">
                  <Button
                    size="compact"
                    tone="text"
                    label={gt("Load earlier")}
                    loading={state.loadingEarlier}
                    disabled={state.loadingEarlier}
                    onPress={() => void session.loadEarlier()}
                  />
                </View>
              ) : null}
              {transcript.items.length === 0 ? (
                <Text className="text-sm text-foreground-muted">
                  <T>Nothing in this thread yet.</T>
                </Text>
              ) : null}
              {transcript.items.map((item) => {
                const presented = presentLinkedThreadItem(item, m);
                return presented === null ? null : (
                  <LinkedThreadItem key={item.position} item={presented} />
                );
              })}
              {failure === null ? null : (
                <FailureCard failure={failure} stale onRetry={session.retry} />
              )}
            </>
          )}
        </ScrollView>
        <View
          className="gap-2 px-3 pt-1.5"
          style={{ paddingBottom: Math.max(insets.bottom, 10) + 6 }}
        >
          <LinkedThreadComposer
            label={label}
            via={via}
            working={working}
            action={
              <Button
                tone="secondary"
                label={gt("Connect to interact")}
                loading={connectState.phase === "connecting"}
                onPress={() => void connect()}
              />
            }
            notice={
              connectState.phase === "connecting" ? (
                <Text
                  accessibilityLiveRegion="polite"
                  className="px-2 text-xs text-foreground-muted"
                >
                  {gt("Connecting to {environment}...", { environment: label })}
                </Text>
              ) : connectState.phase === "unreachable" ? (
                <View
                  accessibilityLiveRegion="polite"
                  className="gap-1 rounded-2xl border border-danger-border bg-danger px-3.5 py-3"
                >
                  <Text className="font-t3-medium text-sm text-danger-foreground">
                    {gt("{label} is not reachable from this device", {
                      label: connectState.label,
                    })}
                  </Text>
                  <Text className="text-sm text-danger-foreground">
                    <T>
                      Join a network it is on, such as its Tailscale network, and try again. You can
                      keep reading here.
                    </T>
                  </Text>
                </View>
              ) : null
            }
          />
        </View>
      </ScreenContent>
    </View>
  );
}

/** The read-only view as its own screen: a sheet, or the whole screen when maximized from the inspector. */
export function LinkedThreadSheet({ route }: StaticScreenProps<LinkedThreadRouteParams>) {
  const { viaEnvironmentId, environmentId, threadId, label, title } = route.params;
  return (
    <LinkedThreadView
      key={`${viaEnvironmentId}:${environmentId}:${threadId}`}
      target={{
        viaEnvironmentId: EnvironmentId.make(viaEnvironmentId),
        environmentId: EnvironmentId.make(environmentId),
        threadId: ThreadId.make(threadId),
        label,
        title: title ?? null,
      }}
    />
  );
}
