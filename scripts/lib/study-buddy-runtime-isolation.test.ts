import { describe, expect, it } from "vite-plus/test";

import { assertStudyBuddyRuntimeIsolation } from "./study-buddy-runtime-isolation.ts";

describe("assertStudyBuddyRuntimeIsolation", () => {
  it("accepts dedicated Study Buddy state and ports", () => {
    expect(() =>
      assertStudyBuddyRuntimeIsolation({
        t3Home: "/workspace/study-buddy/.t3-study-buddy/dev",
        serverPort: 13773,
        webPort: 5733,
        upstreamT3Home: "/home/alvaro/.t3",
      }),
    ).not.toThrow();
  });

  it.each(["/home/alvaro/.t3", "/home/alvaro/.t3/study-buddy"])(
    "rejects upstream T3 state at %s",
    (t3Home) => {
      expect(() =>
        assertStudyBuddyRuntimeIsolation({
          t3Home,
          upstreamT3Home: "/home/alvaro/.t3",
        }),
      ).toThrow("Study Buddy refuses to use upstream T3 state");
    },
  );

  it.each([3773, 3774])("rejects upstream T3 server port %s", (serverPort) => {
    expect(() =>
      assertStudyBuddyRuntimeIsolation({
        t3Home: "/workspace/study-buddy/.t3-study-buddy/dev",
        serverPort,
        webPort: 5733,
        upstreamT3Home: "/home/alvaro/.t3",
      }),
    ).toThrow(`Study Buddy refuses to use upstream T3 server port ${serverPort}`);
  });

  it.each([3773, 3774])("rejects upstream T3 web port %s", (webPort) => {
    expect(() =>
      assertStudyBuddyRuntimeIsolation({
        t3Home: "/workspace/study-buddy/.t3-study-buddy/dev",
        serverPort: 13773,
        webPort,
        upstreamT3Home: "/home/alvaro/.t3",
      }),
    ).toThrow(`Study Buddy refuses to use upstream T3 web port ${webPort}`);
  });
});
