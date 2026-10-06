import { createRequire } from "node:module";
import { describe, expect, it } from "vite-plus/test";

// Resolve the actual transitive packages used by desktop builds and mail parsing.
function dependency(owner: "desktop" | "server", ...chain: string[]): unknown {
  let require = createRequire(new URL(`../apps/${owner}/package.json`, import.meta.url));
  for (const name of chain.slice(0, -1)) require = createRequire(require.resolve(name));
  return require(chain.at(-1)!);
}

describe("Study Buddy dependency security", () => {
  it("rejects a URI port that injects a different authority", () => {
    const uri = dependency("desktop", "electron-builder", "app-builder-lib", "ajv", "fast-uri") as {
      serialize(parts: { scheme: string; host: string; port: string }): string;
    };
    expect(() =>
      uri.serialize({ scheme: "http", host: "trusted.example", port: "@127.0.0.1:8124" }),
    ).toThrow();
  });

  it.each([
    ["@electron/asar", "minimatch", "brace-expansion"],
    ["@electron/universal", "minimatch", "brace-expansion"],
    ["minimatch", "brace-expansion"],
  ])("bounds deeply nested glob braces through %s", (...chain) => {
    const module = dependency("desktop", "electron-builder", "app-builder-lib", ...chain) as
      | ((pattern: string) => string[])
      | { expand: (pattern: string) => string[] };
    const expand = typeof module === "function" ? module : module.expand;
    expect(() => expand("{".repeat(4_000) + "a,b" + "}".repeat(4_000))).not.toThrow();
    expect(expand("file-{a,b}.txt")).toEqual(["file-a.txt", "file-b.txt"]);
  });

  it("keeps max-stale subordinate to shared-cache reuse prohibitions", () => {
    const CachePolicy = dependency(
      "desktop",
      "electron-builder",
      "app-builder-lib",
      "@electron/get",
      "got",
      "cacheable-request",
      "http-cache-semantics",
    ) as new (
      request: { url: string; method: string; headers: Record<string, string> },
      response: { status: number; headers: Record<string, string> },
    ) => {
      storable(): boolean;
      maxAge(): number;
      satisfiesWithoutRevalidation(request: {
        url: string;
        method: string;
        headers: Record<string, string>;
      }): boolean;
    };
    const request = { url: "https://example.test/account", method: "GET", headers: {} };
    const staleRequest = { ...request, headers: { "cache-control": "max-stale=999999" } };
    const blockedHeaders: Array<Record<string, string>> = [
      { "set-cookie": "session=private", "cache-control": "max-age=600" },
      { "cache-control": "max-age=600, proxy-revalidate" },
    ];
    for (const headers of blockedHeaders) {
      const policy = new CachePolicy(request, { status: 200, headers });
      // cacheable-request stores these entries; their zero age requires revalidation.
      expect(policy.storable()).toBe(true);
      expect(policy.maxAge()).toBe(0);
      expect(policy.satisfiesWithoutRevalidation(staleRequest)).toBe(false);
    }
    const publicPolicy = new CachePolicy(request, {
      status: 200,
      headers: { "cache-control": "public, max-age=1", age: "100", "set-cookie": "public=value" },
    });
    expect(publicPolicy.satisfiesWithoutRevalidation(staleRequest)).toBe(true);
  });

  it("preserves MIME recipient parsing with the patched address parser", async () => {
    const parser = dependency("server", "mailparser") as {
      simpleParser(message: string): Promise<{
        to: { value: Array<{ name: string; address: string }> };
        text: string;
      }>;
    };
    const result = await parser.simpleParser(
      'From: sender@example.test\r\nTo: "Study, Buddy" <student@example.test> (course)\r\nSubject: Notes\r\n\r\nStudy notes',
    );
    expect(result.to.value).toEqual([{ name: "Study, Buddy", address: "student@example.test" }]);
    expect(result.text.trim()).toBe("Study notes");
  });
});
