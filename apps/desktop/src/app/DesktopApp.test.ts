import { assert, describe, it } from "@effect/vitest";

import { resolveDesktopBackendPortProbeHosts } from "./DesktopApp.ts";

describe("desktop backend port probes", () => {
  it("does not open public interfaces in the default local-only mode", () => {
    assert.deepEqual(resolveDesktopBackendPortProbeHosts("local-only"), ["127.0.0.1"]);
  });

  it("checks the public bind interface only after network access is enabled", () => {
    assert.deepEqual(resolveDesktopBackendPortProbeHosts("network-accessible"), ["0.0.0.0"]);
  });
});
