import { afterEach, describe, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("server telemetry boundary", () => {
  it("loads the fresh server runtime without telemetry storage or network traffic", async () => {
    const fetchSpy = vi.fn();
    const localStorage = {
      get length(): number {
        throw new Error("The server must not use browser telemetry storage");
      },
      clear: vi.fn(),
      getItem: vi.fn(),
      key: vi.fn(),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    } satisfies Storage;
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("localStorage", localStorage);

    await import("../server.ts");
    await import("../bin.ts");
    await Promise.resolve();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });
});
