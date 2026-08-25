// @effect-diagnostics nodeBuiltinImport:off
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import type { ServerSecretStoreShape } from "../../../auth/ServerSecretStore.ts";
import type { ServerConfigShape } from "../../../config.ts";
import {
  parseEnvDocument,
  patchEnvDocument,
  publicStudyBuddyConfiguration,
  updateStudyBuddyConfiguration,
} from "../studyBuddyConfig.ts";

function secretStore(): {
  readonly store: ServerSecretStoreShape;
  readonly values: Map<string, Uint8Array>;
} {
  const values = new Map<string, Uint8Array>();
  return {
    values,
    store: {
      get: (name) => Effect.succeed(values.get(name) ?? null),
      set: (name, value) => Effect.sync(() => void values.set(name, value)),
      create: (name, value) => Effect.sync(() => void values.set(name, value)),
      getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
      remove: (name) => Effect.sync(() => void values.delete(name)),
    },
  };
}

const secureConfig = (cwd: string) =>
  ({ cwd, sourceSecretKey: Buffer.alloc(32, 9).toString("base64") }) as ServerConfigShape;

describe("typed Study Buddy configuration", () => {
  it("preserves unknown env entries while patching allowlisted values", () => {
    const original = [
      "# operator setting",
      "UNKNOWN_SETTING=keep-me",
      "MOODLE_USERNAME=old",
      "MOODLE_USERNAME=stale-duplicate",
      "MOODLE_PASSWORD=super-secret",
      "",
    ].join("\n");
    const next = patchEnvDocument(original, {
      MOODLE_USERNAME: "if00new",
      CIS_USERNAME: "if00cis",
    });

    expect(next).toContain("# operator setting\n");
    expect(next).toContain("UNKNOWN_SETTING=keep-me\n");
    expect(next).toContain("MOODLE_USERNAME=if00new\n");
    expect(next).not.toContain("stale-duplicate");
    expect(next).toContain("MOODLE_PASSWORD=super-secret\n");
    expect(next).toContain("CIS_USERNAME=if00cis\n");
  });

  it("returns public source URLs while keeping passwords and bearer calendar URLs hidden", () => {
    const raw = [
      "MOODLE_USERNAME=if00test",
      "MOODLE_PASSWORD=secret",
      "MOODLE_DASHBOARD_URL=https://user:pass@moodle.example/my/?id=42&token=url-secret",
      "CIS_PASSWORD=secret-two",
      "CIS_CALENDAR_URL=https://calendar.example/private-token.ics",
    ].join("\n");
    const result = publicStudyBuddyConfiguration({
      envPath: "/private/.env.local",
      exists: true,
      raw,
      values: parseEnvDocument(raw),
    });

    expect(result.moodlePasswordConfigured).toBe(true);
    expect(result.cisPasswordConfigured).toBe(true);
    expect(result.calendarUrlConfigured).toBe(true);
    expect(result.calendarUrl).toBe("");
    expect(result.moodleDashboardUrl).toBe("https://moodle.example/my/?id=42");
    expect(JSON.stringify(result)).not.toContain("secret-two");
    expect(JSON.stringify(result)).not.toContain("private-token");
  });

  it("falls back to review-only for an unsupported stored quiz mode", () => {
    const raw = "MOODLE_QUIZ_ACCESS_MODE=retired-mode\n";
    const result = publicStudyBuddyConfiguration({
      envPath: "/private/.env.local",
      exists: true,
      raw,
      values: parseEnvDocument(raw),
    });

    expect(result.quiz.accessMode).toBe("review-only");
  });

  it("applies password secret operations, stores calendar URLs, and writes mode 0600", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "study-buddy-config-"));
    const previousRoot = process.env.STUDY_BUDDY_ROOT;
    process.env.STUDY_BUDDY_ROOT = root;
    try {
      const config = secureConfig(root);
      const secrets = secretStore();
      await Effect.runPromise(
        updateStudyBuddyConfiguration(
          config,
          {
            moodleUsername: "if00test",
            moodlePassword: { operation: "set", value: "moodle-secret" },
            cisPassword: { operation: "clear" },
            calendarUrlSecret: {
              operation: "set",
              value: "webcal://calendar.example/private.ics",
            },
          },
          secrets.store,
        ),
      );
      await Effect.runPromise(
        updateStudyBuddyConfiguration(
          config,
          {
            moodlePassword: { operation: "unchanged" },
            calendarUrlSecret: { operation: "unchanged" },
          },
          secrets.store,
        ),
      );

      const envPath = path.join(root, ".env.local");
      const raw = await readFile(envPath, "utf8");
      expect(raw).not.toContain("if00test");
      expect(raw).not.toContain("moodle-secret");
      expect(raw).toContain("CIS_PASSWORD=\n");
      expect(raw).not.toContain("private.ics");
      const encrypted = Array.from(secrets.values.values(), (value) =>
        new TextDecoder().decode(value),
      ).join("\n");
      expect(encrypted).not.toContain("moodle-secret");
      expect(encrypted).not.toContain("private.ics");
      expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    } finally {
      if (previousRoot === undefined) delete process.env.STUDY_BUDDY_ROOT;
      else process.env.STUDY_BUDDY_ROOT = previousRoot;
    }
  });

  it("rejects plaintext remote login origins", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "study-buddy-config-"));
    const previousRoot = process.env.STUDY_BUDDY_ROOT;
    process.env.STUDY_BUDDY_ROOT = root;
    try {
      await expect(
        Effect.runPromise(
          updateStudyBuddyConfiguration(
            secureConfig(root),
            {
              moodleDashboardUrl: "http://university.example/login",
            },
            secretStore().store,
          ),
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining("use HTTPS") });
    } finally {
      if (previousRoot === undefined) delete process.env.STUDY_BUDDY_ROOT;
      else process.env.STUDY_BUDDY_ROOT = previousRoot;
    }
  });
});
