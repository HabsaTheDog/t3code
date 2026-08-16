import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import type { DesktopUpdateState } from "@t3tools/contracts";

import { isElectron } from "../env";
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../lib/desktopUpdateReactQuery";
import {
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  getDesktopUpdateNotificationKey,
  resolveDesktopUpdateButtonAction,
} from "./desktopUpdate.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

const seenDesktopUpdateNotificationKeys = new Set<string>();
type DesktopUpdateToastId = ReturnType<typeof toastManager.add>;

interface ActiveDesktopUpdateToast {
  readonly key: string;
  readonly toastId: DesktopUpdateToastId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected updater error occurred.";
}

export function DesktopUpdateLaunchNotification() {
  const queryClient = useQueryClient();
  const state = useDesktopUpdateState().data ?? null;
  const stateRef = useRef<DesktopUpdateState | null>(state);
  const activeToastRef = useRef<ActiveDesktopUpdateToast | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const updateFailureToast = useCallback(
    (toastId: DesktopUpdateToastId, title: string, error: unknown) => {
      toastManager.update(
        toastId,
        stackedThreadToast({
          type: "error",
          title,
          description: errorMessage(error),
          timeout: 0,
          data: { hideCopyButton: true },
        }),
      );
    },
    [],
  );

  const downloadUpdate = useCallback(
    (toastId: DesktopUpdateToastId) => {
      const bridge = window.desktopBridge;
      if (!bridge) return;
      toastManager.update(toastId, {
        type: "loading",
        title: "Downloading Study Buddy update",
        description: "The verified update is being downloaded in the background.",
        timeout: 0,
        data: { hideCopyButton: true },
      });
      void bridge
        .downloadUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
          const actionError = getDesktopUpdateActionError(result);
          if (actionError) updateFailureToast(toastId, "Could not download update", actionError);
        })
        .catch((error: unknown) => {
          updateFailureToast(toastId, "Could not download update", error);
        });
    },
    [queryClient, updateFailureToast],
  );

  const installUpdate = useCallback(
    (toastId: DesktopUpdateToastId) => {
      const bridge = window.desktopBridge;
      const currentState = stateRef.current;
      if (!bridge || !currentState) return;
      if (!window.confirm(getDesktopUpdateInstallConfirmationMessage(currentState))) return;
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
          const actionError = getDesktopUpdateActionError(result);
          if (actionError) updateFailureToast(toastId, "Could not install update", actionError);
        })
        .catch((error: unknown) => {
          updateFailureToast(toastId, "Could not install update", error);
        });
    },
    [queryClient, updateFailureToast],
  );

  useEffect(() => {
    if (!isElectron) return;

    const notificationKey = getDesktopUpdateNotificationKey(state);
    const activeToast = activeToastRef.current;
    if (!notificationKey || !state) {
      if (activeToast) {
        toastManager.close(activeToast.toastId);
        activeToastRef.current = null;
      }
      return;
    }

    if (activeToast && activeToast.key !== notificationKey) {
      toastManager.close(activeToast.toastId);
      activeToastRef.current = null;
    }

    let toastId = activeToastRef.current?.toastId;
    if (!toastId) {
      if (seenDesktopUpdateNotificationKeys.has(notificationKey)) return;
      seenDesktopUpdateNotificationKeys.add(notificationKey);
    }

    const version = state.downloadedVersion ?? state.availableVersion ?? "available";
    const action = resolveDesktopUpdateButtonAction(state);
    const onClose = () => {
      if (activeToastRef.current?.toastId === toastId) activeToastRef.current = null;
    };

    const payload =
      action === "install"
        ? stackedThreadToast({
            type: state.status === "error" ? "error" : "success",
            title: `Study Buddy ${version} is ready`,
            description:
              state.status === "error"
                ? (state.message ?? "The update could not be installed.")
                : "Restart when you are ready to finish installing the update.",
            timeout: 0,
            actionProps: {
              children: state.status === "error" ? "Retry" : "Restart now",
              onClick: () => toastId && installUpdate(toastId),
            },
            data: { hideCopyButton: true, onClose },
          })
        : state.status === "downloading"
          ? {
              type: "loading" as const,
              title: `Downloading Study Buddy ${version}`,
              description:
                typeof state.downloadPercent === "number"
                  ? `${Math.floor(state.downloadPercent)}% complete`
                  : "Downloading and verifying the update…",
              timeout: 0,
              data: { hideCopyButton: true, onClose },
            }
          : stackedThreadToast({
              type: state.status === "error" ? "error" : "info",
              title: `Study Buddy ${version} is available`,
              description:
                state.status === "error"
                  ? (state.message ?? "The update download failed.")
                  : "Download the update now and install it when you are ready.",
              timeout: 0,
              actionProps: {
                children: state.status === "error" ? "Retry" : "Download",
                onClick: () => toastId && downloadUpdate(toastId),
              },
              data: { hideCopyButton: true, onClose },
            });

    if (toastId) {
      toastManager.update(toastId, payload);
    } else {
      toastId = toastManager.add(payload);
      activeToastRef.current = { key: notificationKey, toastId };
    }
  }, [downloadUpdate, installUpdate, state]);

  return null;
}
