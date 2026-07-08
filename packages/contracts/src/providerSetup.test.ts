import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderSetupStartInput, ProviderSetupWriteInput } from "./providerSetup.ts";

describe("provider setup contracts", () => {
  it("accepts only allowlisted setup actions", () => {
    const decode = Schema.decodeUnknownSync(ProviderSetupStartInput);
    expect(decode({ actionId: "codex.auth.device-code" }).actionId).toBe("codex.auth.device-code");
    expect(() => decode({ actionId: "shell.exec", command: "rm -rf /" })).toThrow();
  });

  it("bounds interactive terminal input", () => {
    const decode = Schema.decodeUnknownSync(ProviderSetupWriteInput);
    expect(decode({ jobId: "job-1", input: "yes\n" }).input).toBe("yes\n");
    expect(() => decode({ jobId: "job-1", input: "x".repeat(16_385) })).toThrow();
  });
});
