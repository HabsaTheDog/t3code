// @effect-diagnostics globalTimers:off
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createBrowserLoginConfig } from "../browserAuth.ts";
import { createPlaywrightBrowserClient } from "../playwrightBrowserClient.ts";
import type { MoodleRuntimeConfig } from "../types.ts";

const USERNAME = "broker-test-user";
const PASSWORD = "broker-test-password-canary";

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

describe("Playwright credential broker", () => {
  it("locks extraction during login and redacts credential echoes from later snapshots", async () => {
    let submitted!: () => void;
    const submittedPromise = new Promise<void>((resolve) => {
      submitted = resolve;
    });
    let pendingResponse: ServerResponse | undefined;

    const server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/login") {
        pendingResponse = response;
        request.once("end", submitted);
        request.resume();
        return;
      }
      if (request.url === "/home" && request.headers.cookie === "session=ok") {
        response.setHeader("content-type", "text/html");
        response.end(
          `<main><a href="/course">Course</a><p>hostile echo ${PASSWORD}</p>` +
            `<input type="password" value="${PASSWORD}" aria-label="Visible secret" /></main>`,
        );
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(
        '<form action="/login" method="post"><label>User<input name="username" /></label>' +
          '<label>Password<input name="password" type="password" /></label>' +
          '<button type="submit">Log in</button></form>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closeServer = async () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;

    const client = createPlaywrightBrowserClient(runtimeConfig(origin));
    const loginPromise = client.secureLogin?.(
      createBrowserLoginConfig({
        serviceName: "Test University",
        targetUrl: `${origin}/home`,
        username: USERNAME,
        password: PASSWORD,
      }),
    );
    await submittedPromise;
    await expect(client.snapshot()).rejects.toThrow("authentication is locked");

    pendingResponse?.writeHead(302, { location: "/home", "set-cookie": "session=ok" });
    pendingResponse?.end();
    await loginPromise;

    const snapshot = await client.snapshot({ interactive: false });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).toContain("Course");
    expect(serialized).toContain("credential-field");
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain("••");
    expect(client.authenticationState).toBe("authenticated");
    await client.close();
  });
});

function runtimeConfig(origin: string): MoodleRuntimeConfig {
  return {
    prompt: "test",
    moodleUrl: `${origin}/home`,
    outputPath: "/tmp/document.typ",
    runDir: "/tmp",
    maxDepth: 0,
    maxPages: 1,
    maxCisPages: 1,
    allowFileDownloads: false,
    baseUrl: origin,
    dashboardUrl: `${origin}/home`,
    username: USERNAME,
    password: PASSWORD,
    cisUrls: [],
    cisBaseUrl: origin,
    cisDashboardUrl: origin,
    headless: true,
    browserBackend: "playwright",
    browserAllowedDomains: ["127.0.0.1"],
  };
}
