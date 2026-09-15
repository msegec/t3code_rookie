import type { DiscoveredLocalServer, ScopedThreadRef } from "@t3tools/contracts";
import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { releaseUnusedPreviewGateway } from "~/browser/previewGateway";
import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import type { BrowserSettingsReadError, OpenPreviewMutation } from "~/browser/openFileInPreview";
import { recordVisitForThread } from "~/browserHistoryStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { openPreviewSession } from "./openPreviewSession";

export async function openDiscoveredPort<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly port: DiscoveredLocalServer;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  let resolvedUrl: string | undefined;
  try {
    resolvedUrl = await resolveDiscoveredServerUrl(
      input.threadRef.environmentId,
      input.port.url,
      input.threadRef.threadId,
    );
    const result = await openPreviewSession({
      openPreview: input.openPreview,
      threadRef: input.threadRef,
      url: resolvedUrl,
    });
    if (result._tag === "Failure") releaseUnusedPreviewGateway(resolvedUrl);
    return mapAtomCommandResult(result, (snapshot) => {
      recordVisitForThread(input.threadRef, input.port.url);
      useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
    });
  } catch (error) {
    if (resolvedUrl) releaseUnusedPreviewGateway(resolvedUrl);
    return AsyncResult.failure(Cause.die(error));
  }
}
