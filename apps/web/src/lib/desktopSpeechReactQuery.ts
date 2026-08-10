import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";

export const desktopSpeechQueryKeys = {
  state: () => ["desktop", "speech", "state"] as const,
};

export function desktopSpeechStateQueryOptions() {
  return queryOptions({
    queryKey: desktopSpeechQueryKeys.state(),
    queryFn: async () => window.desktopBridge?.getSpeechModelState?.() ?? null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "downloading" || status === "verifying" ? 750 : 5_000;
    },
    refetchOnMount: "always",
  });
}

export function useDesktopSpeechState() {
  return useQuery(desktopSpeechStateQueryOptions());
}

export function useDesktopSpeechActions() {
  const queryClient = useQueryClient();
  const update = async (action: "enable" | "remove") => {
    const bridge = window.desktopBridge;
    if (!bridge) return null;
    const state =
      action === "enable" ? await bridge.enableSpeechModel() : await bridge.removeSpeechModel();
    queryClient.setQueryData(desktopSpeechQueryKeys.state(), state);
    return state;
  };
  return {
    enable: () => update("enable"),
    remove: () => update("remove"),
  };
}
