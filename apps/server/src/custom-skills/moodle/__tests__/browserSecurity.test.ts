import { describe, expect, it } from "vite-plus/test";

import {
  BrowserAuthenticationGate,
  BrowserAuthenticationLockedError,
  isAuthenticationSnapshot,
  redactSensitiveValues,
  sanitizeBrowserSnapshot,
  sanitizeModelVisibleUrl,
} from "../browserSecurity.ts";

describe("browser credential boundary", () => {
  it("locks every content-reading operation during authentication", () => {
    const gate = new BrowserAuthenticationGate();
    gate.lock();
    expect(() => gate.assertReadable("snapshot")).toThrow(BrowserAuthenticationLockedError);
    gate.authenticate();
    expect(() => gate.assertReadable("snapshot")).not.toThrow();
  });

  it("keeps the lock active while user MFA action is required", () => {
    const gate = new BrowserAuthenticationGate();
    gate.lock();
    gate.requireUserAction();
    expect(gate.state).toBe("user-action-required");
    expect(() => gate.assertReadable("screenshot")).toThrow("authentication is locked");
  });

  it("redacts exact, URL-encoded, echoed, and URL credential values", () => {
    const password = "p@ss word#42";
    const text = [
      `password=${password}`,
      `echo=${encodeURIComponent(password)}`,
      `https://school.example/login?token=${password}`,
    ].join("\n");
    const redacted = redactSensitiveValues(text, [password]);
    expect(redacted).not.toContain(password);
    expect(redacted).not.toContain(encodeURIComponent(password));
    expect(redacted).toContain("[REDACTED");
  });

  it("redacts password fields after a reveal toggle without disclosing bullet count", () => {
    const password = "canary-password-123";
    const sanitized = sanitizeBrowserSnapshot(
      {
        origin: "https://school.example/login#secret-fragment",
        refs: {
          p1: { role: "textbox", name: `Password ${password}` },
          c1: { role: "link", name: "Course" },
        },
        snapshot: [
          `textbox "Password" value="${password}" [ref=p1, type=text]`,
          `status "Login failed for ${password}"`,
        ].join("\n"),
      },
      [password],
    );
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain("••");
    expect(serialized).toContain("credential-field");
    expect(sanitized.origin).not.toContain("secret-fragment");
  });

  it("removes unlabeled password-mask lengths from snapshots and refs", () => {
    const sanitized = sanitizeBrowserSnapshot(
      {
        origin: "https://school.example/profile",
        refs: { p1: { role: "textbox", name: "••••••••••••" } },
        snapshot: 'textbox "••••••••••••" [ref=p1]',
      },
      [],
    );
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("••");
    expect(serialized).toContain("credential-field");
  });

  it("removes userinfo, fragments, and credential query values from URLs", () => {
    expect(
      sanitizeModelVisibleUrl(
        "https://student:password@school.example/course?token=abc&id=7#private",
      ),
    ).toBe("https://school.example/course?token=%5BREDACTED%5D&id=7");
  });

  it("identifies login routes and credential controls so snapshots can be locked", () => {
    expect(
      isAuthenticationSnapshot({
        origin: "https://identity.example/sso/login",
        refs: {},
        snapshot: "",
      }),
    ).toBe(true);
    expect(
      isAuthenticationSnapshot({
        origin: "https://school.example/profile",
        refs: { p1: { role: "textbox", name: "Password" } },
        snapshot: "",
      }),
    ).toBe(true);
    expect(
      isAuthenticationSnapshot({
        origin: "https://school.example/course/7",
        refs: { c1: { role: "link", name: "Course" } },
        snapshot: "",
      }),
    ).toBe(false);
  });
});
