import { describe, expect, it } from "vite-plus/test";

import {
  discoverStudyBuddyWebmailProvider,
  discoverStudyBuddyWebmailProviderFromSnapshot,
  STUDY_BUDDY_MAIL_PROVIDER_PROFILES,
} from "./webmailDiscovery.ts";

describe("Study Buddy webmail provider discovery", () => {
  it("recognizes SOGo without retaining page text or header values", () => {
    const result = discoverStudyBuddyWebmailProviderFromSnapshot({
      url: "https://mail.example.edu/SOGo/",
      status: 200,
      headers: { server: "secret-internal-version", "set-cookie": "sensitive-cookie=value" },
      html: `<html><head><title>University SOGo</title><script src="/SOGo.woa/WebServerResources/js/app.js"></script></head>
        <body><form action="/SOGo/connect"><input name="userName"><input name="password"></form></body></html>`,
    });

    expect(result.profile.id).toBe("sogo");
    expect(result.confidence).toBe("high");
    expect(result.allowedOrigins).toEqual(["https://mail.example.edu"]);
    expect(JSON.stringify(result.researchMetadata)).not.toContain("secret-internal-version");
    expect(JSON.stringify(result.researchMetadata)).not.toContain("sensitive-cookie");
  });

  it("recognizes Roundcube login fields and requires verified state restoration", () => {
    const result = discoverStudyBuddyWebmailProviderFromSnapshot({
      url: "https://webmail.example.edu/roundcube/",
      status: 200,
      html: `<title>Roundcube Webmail</title><form action="./?_task=login">
        <input name="_token"><input id="rcmloginuser" name="_user"><input name="_pass"></form>`,
    });

    expect(result.profile.id).toBe("roundcube");
    expect(result.profile.runtime).toBe("available");
    expect(result.profile.readState.invariant).toBe("verify-and-restore");
  });

  it.each([
    ["https://outlook.office.com/mail/", "microsoft-365"],
    ["https://mail.google.com/mail/u/0/", "google-workspace"],
  ] as const)("recognizes hosted provider %s", (url, providerId) => {
    expect(
      discoverStudyBuddyWebmailProviderFromSnapshot({
        url,
        status: 200,
        html: "<title>Mail</title>",
      }).profile.id,
    ).toBe(providerId);
  });

  it("uses a disabled adaptive fallback for an unknown login page", () => {
    const result = discoverStudyBuddyWebmailProviderFromSnapshot({
      url: "https://mail.example.edu/login",
      status: 200,
      html: `<title>Campus mail</title><form action="/session"><input name="login"><input name="password"></form>`,
    });
    expect(result.profile.id).toBe("other-webmail");
    expect(result.profile.readState.proven).toBe(false);
    expect(result.researchMetadata.fieldNames).toEqual(["login", "password"]);
  });

  it("guards every public redirect hop and never forwards cookies", async () => {
    const checked: string[] = [];
    const requests: RequestInit[] = [];
    const responses = [
      new Response(null, {
        status: 302,
        headers: { location: "https://accounts.google.com/login" },
      }),
      new Response("<title>Google Accounts</title>", { status: 200 }),
    ];
    const result = await discoverStudyBuddyWebmailProvider("https://mail.google.com/", {
      assertPublicUrl: async (url) => void checked.push(url),
      fetch: async (_url, init) => {
        requests.push(init);
        return responses.shift()!;
      },
    });
    expect(result.profile.id).toBe("google-workspace");
    expect(checked).toEqual(["https://mail.google.com/", "https://accounts.google.com/login"]);
    expect(requests.every((request) => request.credentials === "omit")).toBe(true);
  });

  it("keeps the complete provider matrix explicit", () => {
    expect(Object.keys(STUDY_BUDDY_MAIL_PROVIDER_PROFILES).sort()).toEqual([
      "google-workspace",
      "imap",
      "microsoft-365",
      "other-webmail",
      "roundcube",
      "sogo",
    ]);
  });
});
