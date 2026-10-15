// @effect-diagnostics nodeBuiltinImport:off
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { resolveCommandPath } from "@t3tools/shared/shell";

import { fixPath } from "./os-jank.ts";

describe("provider PATH hydration", () => {
  it.each(["linux", "darwin"] as const)(
    "discovers standalone providers installed after %s startup without overriding configured PATH",
    (platform) => {
      const home = mkdtempSync(join(tmpdir(), "study-buddy-provider-path-"));
      try {
        const configuredBin = join(home, "configured-bin");
        const standaloneBin = join(home, ".local", "bin");
        mkdirSync(configuredBin);
        const env = { HOME: home, PATH: configuredBin };
        fixPath({
          env,
          platform,
          readPath: () => join(home, "shell-bin"),
          userShell: "/bin/bash",
        });

        expect(resolveCommandPath("claude", { env, platform })).toBeNull();

        // Installers can finish while the desktop remains open. Keeping the
        // directory on PATH lets later refreshes see their newly created files.
        mkdirSync(standaloneBin, { recursive: true });
        for (const provider of ["codex", "claude"]) {
          const executable = join(standaloneBin, provider);
          writeFileSync(executable, "#!/bin/sh\nexit 0\n");
          chmodSync(executable, 0o755);
          expect(resolveCommandPath(provider, { env, platform })).toBe(executable);
        }

        const configuredCodex = join(configuredBin, "codex");
        writeFileSync(configuredCodex, "#!/bin/sh\nexit 0\n");
        chmodSync(configuredCodex, 0o755);
        expect(resolveCommandPath("codex", { env, platform })).toBe(configuredCodex);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("retains standalone discovery when login shells fail", () => {
    const env = { HOME: "/home/student", PATH: "/usr/bin" };
    fixPath({
      env,
      platform: "linux",
      readPath: () => {
        throw new Error("Shell unavailable");
      },
      logWarning: () => {},
    });
    expect(env.PATH).toBe("/usr/bin:/home/student/.local/bin");
  });
});
