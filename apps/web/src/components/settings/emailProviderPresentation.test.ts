import { describe, expect, it } from "vite-plus/test";

import { recognizeEmailProvider } from "./emailProviderPresentation";

describe("email provider presentation", () => {
  it("recognizes SOGo and Roundcube HTTPS signatures", () => {
    expect(recognizeEmailProvider("auto-detect", "https://mail.example.edu/SOGo/")).toMatchObject({
      status: "recognized",
      label: "SOGo",
    });
    expect(
      recognizeEmailProvider("auto-detect", "https://webmail.example.edu/roundcube/"),
    ).toMatchObject({ status: "recognized", label: "Roundcube" });
  });

  it("recognizes a secure email server without claiming unread safety is verified", () => {
    expect(recognizeEmailProvider("microsoft-365", "imaps://outlook.office365.com:993")).toEqual({
      status: "recognized",
      label: "Microsoft 365 / Outlook",
      detail: "Secure email server recognized.",
    });
  });

  it("does not recognize lookalike hosts that only contain a provider domain", () => {
    expect(
      recognizeEmailProvider("auto-detect", "https://gmail.com.attacker.example/login"),
    ).toMatchObject({ status: "manual" });
    expect(
      recognizeEmailProvider("auto-detect", "https://attacker.example/office.com/login"),
    ).toMatchObject({ status: "manual" });
    expect(
      recognizeEmailProvider("auto-detect", "https://mail.google.com/a/example.edu"),
    ).toMatchObject({ status: "recognized", label: "Google Workspace / Gmail" });
  });

  it("explains that an unknown email website will be checked after saving", () => {
    expect(recognizeEmailProvider("other-webmail", "https://mail.example.edu/login")).toMatchObject(
      { status: "manual", detail: "Study Buddy will check this address after you save." },
    );
  });
});
