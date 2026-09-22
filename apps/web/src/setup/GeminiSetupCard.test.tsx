import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({ installed: true, auth: "unknown" }));
vi.mock("../hooks/useSettings", () => ({ useSettings: () => ({ providerInstances: {} }) }));
vi.mock("../rpc/serverState", () => ({
  useServerProviders: () => [
    { instanceId: "antigravity", installed: fixture.installed, auth: { status: fixture.auth } },
  ],
}));

import { GeminiSetupCard } from "./GeminiSetupCard";

describe("Gemini connection recovery", () => {
  beforeEach(() => {
    fixture.installed = true;
    fixture.auth = "unknown";
  });

  it("offers a connection check without misreporting an unchecked saved login as signed out", () => {
    const markup = renderToStaticMarkup(<GeminiSetupCard />);
    expect(markup).toContain("Check connection");
    expect(markup).toContain("Check your saved connection or sign in");
    expect(markup).not.toContain("Sign-in needed");
  });

  it("shows model refresh and account management after authentication", () => {
    fixture.auth = "authenticated";
    const markup = renderToStaticMarkup(<GeminiSetupCard />);
    expect(markup).toContain("Signed in");
    expect(markup).toContain("Refresh models");
    expect(markup).toContain("Disconnect Google");
    expect(markup).not.toContain("Check connection");
  });

  it("requires installation before attempting a connection", () => {
    fixture.installed = false;
    const markup = renderToStaticMarkup(<GeminiSetupCard />);
    expect(markup).toContain("Install Antigravity");
    expect(markup).not.toContain("Check connection");
    expect(markup).not.toContain("Sign in with Google");
  });
});
