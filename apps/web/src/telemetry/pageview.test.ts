import { describe, expect, it } from "vite-plus/test";

import { privacySafePageviewProperties, privacySafeRoute } from "./pageview";

describe("privacy-safe native pageviews", () => {
  it("collapses dynamic chat routes to the canonical chat page", () => {
    expect(
      privacySafePageviewProperties(
        "/_chat/environment-secret/thread-secret?token=private#conversation",
      ),
    ).toEqual({
      route: "chat",
      $current_url: "https://app.t3.codes/_chat/",
    });
  });

  it("keeps only allowlisted settings sections", () => {
    expect(privacySafeRoute("/settings/privacy?returnTo=/private/thread")).toBe(
      "/settings/privacy",
    );
    expect(privacySafePageviewProperties("/settings/private-course/secret")).toEqual({
      route: "/settings",
      $current_url: "https://app.t3.codes/settings",
    });
  });

  it("maps unknown application paths without retaining their contents", () => {
    const properties = privacySafePageviewProperties("/private/project/alvaro?key=secret");
    expect(properties).toEqual({
      route: "application",
      $current_url: "https://app.t3.codes/application",
    });
    expect(JSON.stringify(properties)).not.toContain("alvaro");
    expect(JSON.stringify(properties)).not.toContain("secret");
  });
});
