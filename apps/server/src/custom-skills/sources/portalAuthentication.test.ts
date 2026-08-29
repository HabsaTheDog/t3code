// @effect-diagnostics nodeBuiltinImport:off
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser } from "playwright";

import { resolveSystemBrowserExecutable } from "../moodle/browserRuntime.ts";
import type { LoginCandidateClassifierInput } from "./loginCandidateClassifier.ts";
import { connectPasswordPortal } from "./portalAuthentication.ts";

let browser!: Browser;

beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    executablePath: await resolveSystemBrowserExecutable(),
  });
});

afterAll(async () => {
  await browser?.close();
});

describe("secure password portal authentication", () => {
  it("retries an HTTP Basic challenge with credentials scoped to the target origin", async () => {
    const username = "basic-user";
    const password = "basic-password";
    const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    let unauthorized = 0;
    let authorized = 0;
    await withFixture(
      async (request, response) => {
        if (request.headers.authorization !== expected) {
          unauthorized += 1;
          response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Fixture"' });
          response.end("Authentication required");
          return;
        }
        authorized += 1;
        html(response, "<main>Authenticated portal</main>");
      },
      async (origin) => {
        await connectPasswordPortal({
          browser,
          serviceName: "Basic fixture",
          targetUrl: `${origin}/protected`,
          username,
          password,
          allowedOrigins: [origin],
        });
      },
    );
    expect(unauthorized).toBeGreaterThan(0);
    expect(authorized).toBeGreaterThan(0);
  });

  it.each([
    {
      name: "conventional form",
      form: `<form method="post" action="/login"><input id="username" name="username" autocomplete="username"><input id="password" name="password" type="password" autocomplete="current-password"><button id="loginbtn" type="submit">Sign in</button></form>`,
    },
    {
      name: "nonstandard semantic form",
      form: `<form aria-label="Member access" method="post" action="/login"><label>Account identifier<input name="principal" type="text"></label><label>Secure phrase<input name="credential" type="password"></label><button type="submit">Enter account</button></form>`,
    },
  ])("authenticates a $name deterministically", async ({ form }) => {
    const classifier = vi.fn(async () => null);
    await withCookieLoginFixture(form, async (origin) => {
      await connectPasswordPortal({
        browser,
        serviceName: "Form fixture",
        targetUrl: `${origin}/login`,
        username: "student",
        password: "secret",
        allowedOrigins: [origin],
        classifyCandidates: classifier,
      });
    });
    expect(classifier).not.toHaveBeenCalled();
  });

  it("supports username-then-password navigation without exposing the post-fill page to a model", async () => {
    const classifier = vi.fn(async () => null);
    const received: string[] = [];
    await withFixture(
      async (request, response) => {
        const body = await requestBody(request);
        if (request.method === "POST") received.push(body);
        if (request.url === "/login") {
          html(
            response,
            `<form method="post" action="/password"><input autocomplete="username" name="account"><button type="submit">Next</button></form>`,
          );
        } else if (request.url === "/password") {
          html(
            response,
            `<form method="post" action="/done"><input type="password" autocomplete="current-password" name="credential"><button type="submit">Sign in</button></form>`,
          );
        } else if (request.url === "/done") {
          response.writeHead(302, {
            Location: "/dashboard",
            "Set-Cookie": "auth=1; HttpOnly; SameSite=Lax",
          });
          response.end();
        } else if (request.url === "/dashboard" && hasAuthCookie(request)) {
          html(response, "<main>Authenticated</main>");
        } else {
          response.writeHead(401);
          response.end();
        }
      },
      async (origin) => {
        await connectPasswordPortal({
          browser,
          serviceName: "Multi-step fixture",
          targetUrl: `${origin}/login`,
          username: "student",
          password: "secret",
          allowedOrigins: [origin],
          classifyCandidates: classifier,
        });
      },
    );
    expect(received).toEqual(["account=student", "credential=secret"]);
    expect(classifier).not.toHaveBeenCalled();
  });

  it("discovers a login form in an allowed same-origin frame", async () => {
    const classifier = vi.fn(async () => null);
    await withFixture(
      async (request, response) => {
        if (request.url === "/portal") {
          html(response, `<main>Portal</main><iframe src="/frame-login"></iframe>`);
        } else if (request.url === "/frame-login" && hasAuthCookie(request)) {
          html(response, "<main>Authenticated frame</main>");
        } else if (request.url === "/frame-login" && request.method === "POST") {
          response.writeHead(302, {
            Location: "/frame-login",
            "Set-Cookie": "auth=1; HttpOnly; SameSite=Lax",
          });
          response.end();
        } else if (request.url === "/frame-login") {
          html(
            response,
            `<form method="post"><input autocomplete="username" name="username"><input type="password" autocomplete="current-password" name="password"><button type="submit">Sign in</button></form>`,
          );
        } else {
          response.writeHead(404);
          response.end();
        }
      },
      async (origin) => {
        await connectPasswordPortal({
          browser,
          serviceName: "Frame fixture",
          targetUrl: `${origin}/portal`,
          username: "student",
          password: "secret",
          allowedOrigins: [origin],
          classifyCandidates: classifier,
        });
      },
    );
    expect(classifier).not.toHaveBeenCalled();
  });

  it("ignores a cross-origin framed login surface", async () => {
    let posted = false;
    await withFixture(
      async (request, response) => {
        if (request.method === "POST") posted = true;
        html(
          response,
          `<form method="post"><input autocomplete="username" name="username"><input type="password" autocomplete="current-password" name="password"><button type="submit">Sign in</button></form>`,
        );
      },
      async (untrustedOrigin) => {
        await withFixture(
          (_request, response) => {
            html(response, `<main>Portal</main><iframe src="${untrustedOrigin}/login"></iframe>`);
          },
          async (origin) => {
            await expect(
              connectPasswordPortal({
                browser,
                serviceName: "Cross-origin frame fixture",
                targetUrl: `${origin}/portal`,
                username: "student",
                password: "secret",
                allowedOrigins: [origin],
              }),
            ).rejects.toThrow("credentials could not be verified");
          },
        );
      },
    );
    expect(posted).toBe(false);
  });

  it("rejects an unexpected cross-origin redirect before credential discovery", async () => {
    let posted = false;
    await withFixture(
      async (request, response) => {
        if (request.method === "POST") posted = true;
        html(
          response,
          `<form method="post"><input autocomplete="username" name="username"><input type="password" autocomplete="current-password" name="password"><button type="submit">Sign in</button></form>`,
        );
      },
      async (untrustedOrigin) => {
        await withFixture(
          (_request, response) => {
            response.writeHead(302, { Location: `${untrustedOrigin}/capture` });
            response.end();
          },
          async (origin) => {
            await expect(
              connectPasswordPortal({
                browser,
                serviceName: "Redirect fixture",
                targetUrl: `${origin}/login`,
                username: "student",
                password: "secret",
                allowedOrigins: [origin],
              }),
            ).rejects.toThrow(/unexpected origin/i);
          },
        );
      },
    );
    expect(posted).toBe(false);
  });

  it("uses only sanitized pre-fill metadata for an ambiguous classifier fallback", async () => {
    const username = "canary-user";
    const password = "canary-password";
    let captured: LoginCandidateClassifierInput | undefined;
    const classifier = vi.fn(async (input: LoginCandidateClassifierInput) => {
      captured = input;
      return {
        usernameCandidateId: "candidate-1",
        passwordCandidateId: "candidate-2",
        actionCandidateId: "candidate-3",
        actionRole: "submit" as const,
        confidence: 0.95,
      };
    });
    await withCookieLoginFixture(
      `<form method="post" action="/login"><label>Username ${username}<input autocomplete="username" name="decoy"></label><label>Account ${username}<input autocomplete="username" name="username"></label><input type="password" autocomplete="current-password" name="password"><button type="submit">Sign in</button></form>`,
      async (origin) => {
        await connectPasswordPortal({
          browser,
          serviceName: "Ambiguous fixture",
          targetUrl: `${origin}/login`,
          username,
          password,
          allowedOrigins: [origin],
          classifyCandidates: classifier,
        });
      },
    );
    const serialized = JSON.stringify(captured);
    expect(classifier).toHaveBeenCalledTimes(1);
    expect(serialized).not.toContain(username);
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain("value");
    expect(serialized).toContain("[REDACTED_CREDENTIAL]");
  });

  it("fails closed on mutation forms without inserting credentials", async () => {
    let posted = false;
    await withFixture(
      async (request, response) => {
        if (request.method === "POST") posted = true;
        html(
          response,
          `<form method="post"><label>Account<input autocomplete="username"></label><label>New password<input type="password" autocomplete="new-password"></label><label>Confirm password<input type="password"></label><button type="submit">Reset password</button></form>`,
        );
      },
      async (origin) => {
        await expect(
          connectPasswordPortal({
            browser,
            serviceName: "Mutation fixture",
            targetUrl: `${origin}/reset-password`,
            username: "student",
            password: "secret",
            allowedOrigins: [origin],
            classifyCandidates: async () => ({
              usernameCandidateId: "candidate-0",
              passwordCandidateId: "candidate-1",
              actionCandidateId: "candidate-3",
              actionRole: "submit",
              confidence: 1,
            }),
          }),
        ).rejects.toThrow(/verified|ambiguous|unsupported/i);
      },
    );
    expect(posted).toBe(false);
  });

  it("fails closed when multiple current-password fields are plausible", async () => {
    let posted = false;
    await withFixture(
      async (request, response) => {
        if (request.method === "POST") posted = true;
        html(
          response,
          `<form method="post"><input autocomplete="username" name="username"><label>Primary password<input type="password" autocomplete="current-password" name="primary"></label><label>Security password<input type="password" autocomplete="current-password" name="secondary"></label><button type="submit">Sign in</button></form>`,
        );
      },
      async (origin) => {
        await expect(
          connectPasswordPortal({
            browser,
            serviceName: "Ambiguous password fixture",
            targetUrl: `${origin}/login`,
            username: "student",
            password: "secret",
            allowedOrigins: [origin],
            classifyCandidates: async () => null,
          }),
        ).rejects.toThrow(/multiple password fields/i);
      },
    );
    expect(posted).toBe(false);
  });

  it.each([
    ["passkey", `<form method="post"><button type="submit">Use passkey</button></form>`],
    ["OAuth consent", `<form method="post"><button type="submit">Allow access</button></form>`],
  ])("does not click an interactive %s flow", async (_name, form) => {
    let posted = false;
    await withFixture(
      async (request, response) => {
        if (request.method === "POST") posted = true;
        html(response, form);
      },
      async (origin) => {
        await expect(
          connectPasswordPortal({
            browser,
            serviceName: "Interactive fixture",
            targetUrl: `${origin}/login`,
            username: "student",
            password: "secret",
            allowedOrigins: [origin],
          }),
        ).rejects.toThrow(/ambiguous|unsupported|user action/i);
      },
    );
    expect(posted).toBe(false);
  });

  it("does not mistake an account-settings password form for a login", async () => {
    let posted = false;
    await withFixture(
      async (request, response) => {
        if (request.method === "POST") posted = true;
        html(
          response,
          `<form method="post" action="/save"><label>Account<input autocomplete="username"></label><label>Current password<input type="password" autocomplete="current-password"></label><button type="submit">Save</button></form>`,
        );
      },
      async (origin) => {
        await expect(
          connectPasswordPortal({
            browser,
            serviceName: "Settings fixture",
            targetUrl: `${origin}/account/settings`,
            username: "student",
            password: "secret",
            allowedOrigins: [origin],
          }),
        ).rejects.toThrow("credentials could not be verified");
      },
    );
    expect(posted).toBe(false);
  });
});

async function withCookieLoginFixture(
  form: string,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  await withFixture(async (request, response) => {
    if (request.url === "/login" && request.method === "POST") {
      response.writeHead(302, {
        Location: "/dashboard",
        "Set-Cookie": "auth=1; HttpOnly; SameSite=Lax",
      });
      response.end();
    } else if (request.url === "/login" && hasAuthCookie(request)) {
      html(response, "<main>Authenticated</main>");
    } else if (request.url === "/login") {
      html(response, form);
    } else if (request.url === "/dashboard" && hasAuthCookie(request)) {
      html(response, "<main>Authenticated</main>");
    } else {
      response.writeHead(401);
      response.end();
    }
  }, run);
}

async function withFixture(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><body>${body}</body></html>`);
}

function hasAuthCookie(request: IncomingMessage): boolean {
  return request.headers.cookie?.split(/;\s*/).includes("auth=1") === true;
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
