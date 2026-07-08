// @effect-diagnostics nodeBuiltinImport:off
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import type { ServerConfigShape } from "../../../config.ts";
import {
  parseEnvDocument,
  patchEnvDocument,
  publicStudyBuddyConfiguration,
  updateStudyBuddyConfiguration,
} from "../studyBuddyConfig.ts";

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

  it("returns public URLs while keeping only passwords hidden", () => {
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
    expect(result.calendarUrl).toBe("https://calendar.example/private-token.ics");
    expect(result.moodleDashboardUrl).toBe("https://moodle.example/my/?id=42");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("applies password secret operations, stores calendar URLs, and writes mode 0600", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "study-buddy-config-"));
    const previousRoot = process.env.STUDY_BUDDY_ROOT;
    process.env.STUDY_BUDDY_ROOT = root;
    try {
      const config = { cwd: root } as ServerConfigShape;
      await Effect.runPromise(
        updateStudyBuddyConfiguration(config, {
          moodleUsername: "if00test",
          moodlePassword: { operation: "set", value: "moodle-secret" },
          cisPassword: { operation: "clear" },
          calendarUrl: "webcal://calendar.example/private.ics",
        }),
      );
      await Effect.runPromise(
        updateStudyBuddyConfiguration(config, {
          moodlePassword: { operation: "unchanged" },
          calendarUrl: "webcal://calendar.example/private.ics",
        }),
      );

      const envPath = path.join(root, ".env.local");
      const raw = await readFile(envPath, "utf8");
      expect(raw).toContain("MOODLE_PASSWORD=moodle-secret\n");
      expect(raw).toContain("CIS_PASSWORD=\n");
      expect(raw).toContain("CIS_CALENDAR_URL=webcal://calendar.example/private.ics\n");
      expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    } finally {
      if (previousRoot === undefined) delete process.env.STUDY_BUDDY_ROOT;
      else process.env.STUDY_BUDDY_ROOT = previousRoot;
    }
  });
});
