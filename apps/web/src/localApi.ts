import type { ContextMenuItem, LocalApi } from "@t3tools/contracts";
import type { WsRpcClient } from "@t3tools/client-runtime";

import { resetVcsStatusStateForTests } from "./lib/vcsStatusState";
import { resetSourceControlDiscoveryStateForTests } from "./lib/sourceControlDiscoveryState";
import { resetRequestLatencyStateForTests } from "./rpc/requestLatencyState";
import { resetServerStateForTests } from "./rpc/serverState";
import { resetWsConnectionStateForTests } from "./rpc/wsConnectionState";
import {
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
} from "./environments/runtime";
import {
  getPrimaryEnvironmentConnection,
  resetEnvironmentServiceForTests,
} from "./environments/runtime";
import { getPrimaryKnownEnvironment } from "./environments/primary";
import { showContextMenuFallback } from "./contextMenuFallback";
import {
  readBrowserClientSettings,
  readBrowserSavedEnvironmentRegistry,
  readBrowserSavedEnvironmentSecret,
  removeBrowserSavedEnvironmentSecret,
  writeBrowserClientSettings,
  writeBrowserSavedEnvironmentRegistry,
  writeBrowserSavedEnvironmentSecret,
} from "./clientPersistenceStorage";

let cachedApi: LocalApi | undefined;

function unavailableLocalBackendError(): Error {
  return new Error("Local backend API is unavailable before a backend is paired.");
}

function createBrowserLocalApi(rpcClient?: WsRpcClient): LocalApi {
  return {
    dialogs: {
      pickFolder: async (options) => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder(options);
      },
      confirm: async (message) => {
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    shell: {
      openInEditor: (cwd, editor, workspaceKind) =>
        rpcClient
          ? rpcClient.shell.openInEditor({
              cwd,
              editor,
              ...(workspaceKind ? { workspaceKind } : {}),
            })
          : Promise.reject(unavailableLocalBackendError()),
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    persistence: {
      getClientSettings: async () => {
        if (window.desktopBridge) {
          return window.desktopBridge.getClientSettings();
        }
        return readBrowserClientSettings();
      },
      setClientSettings: async (settings) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setClientSettings(settings);
        }
        writeBrowserClientSettings(settings);
      },
      getSavedEnvironmentRegistry: async () => {
        if (window.desktopBridge) {
          return window.desktopBridge.getSavedEnvironmentRegistry();
        }
        return readBrowserSavedEnvironmentRegistry();
      },
      setSavedEnvironmentRegistry: async (records) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setSavedEnvironmentRegistry(records);
        }
        writeBrowserSavedEnvironmentRegistry(records);
      },
      getSavedEnvironmentSecret: async (environmentId) => {
        if (window.desktopBridge) {
          return window.desktopBridge.getSavedEnvironmentSecret(environmentId);
        }
        return readBrowserSavedEnvironmentSecret(environmentId);
      },
      setSavedEnvironmentSecret: async (environmentId, secret) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setSavedEnvironmentSecret(environmentId, secret);
        }
        return writeBrowserSavedEnvironmentSecret(environmentId, secret);
      },
      removeSavedEnvironmentSecret: async (environmentId) => {
        if (window.desktopBridge) {
          return window.desktopBridge.removeSavedEnvironmentSecret(environmentId);
        }
        removeBrowserSavedEnvironmentSecret(environmentId);
      },
    },
    server: {
      getConfig: () =>
        rpcClient ? rpcClient.server.getConfig() : Promise.reject(unavailableLocalBackendError()),
      refreshProviders: () =>
        rpcClient
          ? rpcClient.server.refreshProviders()
          : Promise.reject(unavailableLocalBackendError()),
      updateProvider: (input) =>
        rpcClient
          ? rpcClient.server.updateProvider(input)
          : Promise.reject(unavailableLocalBackendError()),
      getProviderSetupCapabilities: () =>
        rpcClient
          ? rpcClient.server.getProviderSetupCapabilities()
          : Promise.reject(unavailableLocalBackendError()),
      startProviderSetup: (input) =>
        rpcClient
          ? rpcClient.server.startProviderSetup(input)
          : Promise.reject(unavailableLocalBackendError()),
      cancelProviderSetup: (input) =>
        rpcClient
          ? rpcClient.server.cancelProviderSetup(input)
          : Promise.reject(unavailableLocalBackendError()),
      writeProviderSetupInput: (input) =>
        rpcClient
          ? rpcClient.server.writeProviderSetupInput(input)
          : Promise.reject(unavailableLocalBackendError()),
      subscribeProviderSetupJob: (input, listener) => {
        if (!rpcClient) throw unavailableLocalBackendError();
        return rpcClient.server.subscribeProviderSetupJob(input, listener);
      },
      upsertKeybinding: (input) =>
        rpcClient
          ? rpcClient.server.upsertKeybinding(input)
          : Promise.reject(unavailableLocalBackendError()),
      removeKeybinding: (input) =>
        rpcClient
          ? rpcClient.server.removeKeybinding(input)
          : Promise.reject(unavailableLocalBackendError()),
      getSettings: () =>
        rpcClient ? rpcClient.server.getSettings() : Promise.reject(unavailableLocalBackendError()),
      updateSettings: (patch) =>
        rpcClient
          ? rpcClient.server.updateSettings(patch)
          : Promise.reject(unavailableLocalBackendError()),
      discoverSourceControl: () =>
        rpcClient
          ? rpcClient.server.discoverSourceControl()
          : Promise.reject(unavailableLocalBackendError()),
      getTraceDiagnostics: () =>
        rpcClient
          ? rpcClient.server.getTraceDiagnostics()
          : Promise.reject(unavailableLocalBackendError()),
      getProcessDiagnostics: () =>
        rpcClient
          ? rpcClient.server.getProcessDiagnostics()
          : Promise.reject(unavailableLocalBackendError()),
      getProcessResourceHistory: (input) =>
        rpcClient
          ? rpcClient.server.getProcessResourceHistory(input)
          : Promise.reject(unavailableLocalBackendError()),
      signalProcess: (input) =>
        rpcClient
          ? rpcClient.server.signalProcess(input)
          : Promise.reject(unavailableLocalBackendError()),
      getStudyBuddyConfiguration: () =>
        rpcClient
          ? rpcClient.server.getStudyBuddyConfiguration()
          : Promise.reject(unavailableLocalBackendError()),
      updateStudyBuddyConfiguration: (input) =>
        rpcClient
          ? rpcClient.server.updateStudyBuddyConfiguration(input)
          : Promise.reject(unavailableLocalBackendError()),
      testStudyBuddyConnection: (input) =>
        rpcClient
          ? rpcClient.server.testStudyBuddyConnection(input)
          : Promise.reject(unavailableLocalBackendError()),
      getStudyBuddySourceInventory: () =>
        rpcClient
          ? rpcClient.server.getStudyBuddySourceInventory()
          : Promise.reject(unavailableLocalBackendError()),
      createStudyBuddySource: (input) =>
        rpcClient
          ? rpcClient.server.createStudyBuddySource(input)
          : Promise.reject(unavailableLocalBackendError()),
      updateStudyBuddySource: (input) =>
        rpcClient
          ? rpcClient.server.updateStudyBuddySource(input)
          : Promise.reject(unavailableLocalBackendError()),
      deleteStudyBuddySource: (input) =>
        rpcClient
          ? rpcClient.server.deleteStudyBuddySource(input)
          : Promise.reject(unavailableLocalBackendError()),
      setStudyBuddySourceAuth: (input) =>
        rpcClient
          ? rpcClient.server.setStudyBuddySourceAuth(input)
          : Promise.reject(unavailableLocalBackendError()),
      updateStudyBuddyEmailPermissions: (input) =>
        rpcClient
          ? rpcClient.server.updateStudyBuddyEmailPermissions(input)
          : Promise.reject(unavailableLocalBackendError()),
      testStudyBuddySource: (input) =>
        rpcClient
          ? rpcClient.server.testStudyBuddySource(input)
          : Promise.reject(unavailableLocalBackendError()),
      listStudyBuddyEmailMessages: (input) =>
        rpcClient
          ? rpcClient.server.listStudyBuddyEmailMessages(input)
          : Promise.reject(unavailableLocalBackendError()),
      searchStudyBuddyEmailMessages: (input) =>
        rpcClient
          ? rpcClient.server.searchStudyBuddyEmailMessages(input)
          : Promise.reject(unavailableLocalBackendError()),
      readStudyBuddyEmailMessage: (input) =>
        rpcClient
          ? rpcClient.server.readStudyBuddyEmailMessage(input)
          : Promise.reject(unavailableLocalBackendError()),
    },
  };
}

export function createLocalApi(rpcClient: WsRpcClient): LocalApi {
  return createBrowserLocalApi(rpcClient);
}

export function readLocalApi(): LocalApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  if (window.nativeApi) {
    cachedApi = window.nativeApi;
    return cachedApi;
  }

  const primaryEnvironment = getPrimaryKnownEnvironment();
  cachedApi = primaryEnvironment
    ? createLocalApi(getPrimaryEnvironmentConnection().client)
    : createBrowserLocalApi();
  return cachedApi;
}

export function ensureLocalApi(): LocalApi {
  const api = readLocalApi();
  if (!api) {
    throw new Error("Local API not found");
  }
  return api;
}

export async function __resetLocalApiForTests() {
  cachedApi = undefined;
  const { __resetClientSettingsPersistenceForTests } = await import("./hooks/useSettings");
  __resetClientSettingsPersistenceForTests();
  await resetEnvironmentServiceForTests();
  resetVcsStatusStateForTests();
  resetSourceControlDiscoveryStateForTests();
  resetRequestLatencyStateForTests();
  resetSavedEnvironmentRegistryStoreForTests();
  resetSavedEnvironmentRuntimeStoreForTests();
  resetServerStateForTests();
  resetWsConnectionStateForTests();
}
