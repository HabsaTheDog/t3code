// @effect-diagnostics nodeBuiltinImport:off - Isolated native journal filesystem tests.
// @effect-diagnostics globalDate:off - Fixture wall-clock boundary.
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DesktopEnvironment, type DesktopEnvironmentShape } from "./DesktopEnvironment.ts";
import {
  recordDesktopHealthFailure,
  readDesktopHealthEvents,
  acknowledgeDesktopHealthEvents,
} from "./DesktopHealthJournal.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "study-buddy-health-test-"));
  directories.push(directory);
  const environment = {
    stateDir: directory,
    clientSettingsPath: path.join(directory, "settings.json"),
    appVersion: "0.2.3-alpha",
    platform: "win32",
  } as DesktopEnvironmentShape;
  const consent = async (patch: Record<string, unknown> = {}) =>
    writeFile(
      environment.clientSettingsPath,
      JSON.stringify({
        analyticsConsent: "accepted",
        consentVersion: 1,
        analyticsEnabledAt: new Date(Date.now() - 1_000).toISOString(),
        ...patch,
      }),
    );
  const record = (
    message = "failed to download update",
    detail = "EACCES private-token C:\\Users\\private",
  ) =>
    Effect.runPromise(
      recordDesktopHealthFailure("desktop-updater", message, { message: detail }).pipe(
        Effect.provideService(DesktopEnvironment, environment),
      ),
    );
  return { environment, consent, record, file: path.join(directory, "telemetry-health.json") };
}
describe("native health journal", () => {
  it("does not create diagnostics without current explicit consent", async () => {
    const test = await fixture();
    await test.record();
    await expect(stat(test.file)).rejects.toThrow();
    await test.consent({ consentVersion: 0 });
    await test.record();
    expect(await readDesktopHealthEvents(test.environment)).toEqual([]);
    await expect(stat(test.file)).rejects.toThrow();
  });
  it("persists only categories, deduplicates immediate repeats and removes acknowledgements", async () => {
    const test = await fixture();
    await test.consent();
    await test.record();
    await test.record();
    const events = await readDesktopHealthEvents(test.environment);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "desktop.update_failed",
      failureKind: "permission",
      failureStage: "download",
      platform: "win32",
    });
    expect(await readFile(test.file, "utf8")).not.toMatch(/private-token|Users/);
    expect((await stat(test.file)).mode & 0o777).toBe(0o600);
    await acknowledgeDesktopHealthEvents(test.environment, [events[0]!.id]);
    expect(await readDesktopHealthEvents(test.environment)).toEqual([]);
  });
  it("purges revoked diagnostics and excludes a previous consent epoch", async () => {
    const test = await fixture();
    await test.consent();
    await test.record();
    await test.consent({ analyticsConsent: "rejected" });
    expect(await readDesktopHealthEvents(test.environment)).toEqual([]);
    await expect(stat(test.file)).rejects.toThrow();
    await test.consent();
    await test.record();
    await test.consent({ analyticsEnabledAt: new Date(Date.now() + 1_000).toISOString() });
    expect(await readDesktopHealthEvents(test.environment)).toEqual([]);
  });
  it("ignores malformed and oversized journals without breaking startup", async () => {
    const test = await fixture();
    await test.consent();
    await writeFile(test.file, "not json");
    expect(await readDesktopHealthEvents(test.environment)).toEqual([]);
    await writeFile(test.file, "x".repeat(129 * 1024));
    expect(await readDesktopHealthEvents(test.environment)).toEqual([]);
  });
});
