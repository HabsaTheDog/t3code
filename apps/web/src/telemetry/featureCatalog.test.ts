import { describe, expect, it } from "vite-plus/test";

import {
  commandPaletteFeature,
  FEATURE_CATALOG,
  featureProperties,
  featuresExposedOnRoute,
} from "./featureCatalog";

describe("feature telemetry catalog", () => {
  it("contains only unique, stable identifiers", () => {
    const ids = FEATURE_CATALOG.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z]+(?:[._][a-z]+)*$/u.test(id))).toBe(true);
  });

  it("maps dynamic command-palette project actions to one stable feature", () => {
    expect(commandPaletteFeature("add-project:environment-id:local")).toBe("project.management");
    expect(commandPaletteFeature("new-thread")).toBe("chat.run");
    expect(commandPaletteFeature("settings")).toBeNull();
  });

  it("describes route exposure without route or user content", () => {
    expect(featuresExposedOnRoute("chat")).toContain("chat.profile");
    expect(featuresExposedOnRoute("chat")).toContain("email.permissions");
    expect(featuresExposedOnRoute("/settings/study-buddy")).toEqual(
      expect.arrayContaining(["sources.management", "sources.connection", "email.inbox"]),
    );
    expect(featuresExposedOnRoute("/settings/general")).toContain("settings.theme");
    expect(featuresExposedOnRoute("chat")).not.toContain("chat.voice");
    expect(FEATURE_CATALOG.map(({ id }) => id)).toContain("voice.setup");
    expect(featureProperties("chat.profile", { surface: "chat" })).toEqual({
      feature: "chat.profile",
      feature_area: "Chat",
      feature_label: "Choose an execution profile",
      surface: "chat",
    });
  });
});
