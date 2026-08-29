// @effect-diagnostics nodeBuiltinImport:off -- verifies native process-tree termination contracts.
import { describe, expect, it, vi } from "vite-plus/test";

import { terminateWorkflowTree } from "./workflowBrokerHttp.ts";

describe("Study Buddy workflow broker process termination", () => {
  it("uses taskkill tree termination on Windows", () => {
    const kill = vi.fn(() => true);
    const spawnSyncProcess = vi.fn(() => ({ status: 0 }));

    terminateWorkflowTree({ pid: 321, kill }, "win32", spawnSyncProcess);

    expect(spawnSyncProcess).toHaveBeenCalledWith("taskkill.exe", ["/PID", "321", "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("falls back to killing the wrapper when Windows tree termination fails", () => {
    const kill = vi.fn(() => true);
    const spawnSyncProcess = vi.fn(() => ({ status: 1 }));

    terminateWorkflowTree({ pid: 654, kill }, "win32", spawnSyncProcess);

    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("terminates the detached process group on Unix-like systems", () => {
    vi.useFakeTimers();
    const kill = vi.fn(() => true);
    const killProcess = vi.fn(() => true) as unknown as typeof process.kill;

    const cancelEscalation = terminateWorkflowTree(
      { pid: 777, kill },
      "linux",
      undefined,
      killProcess,
    );

    expect(killProcess).toHaveBeenCalledWith(-777, "SIGTERM");
    vi.advanceTimersByTime(2_000);
    expect(killProcess).toHaveBeenCalledWith(-777, "SIGKILL");
    expect(kill).not.toHaveBeenCalled();
    cancelEscalation?.();
    vi.useRealTimers();
  });
});
