import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createStudyBuddyWebmailRuntime,
  type StudyBuddyWebmailAccess,
  type WebmailProfileSession,
  type WebmailProviderProfile,
} from "./webmailProfileRuntime.ts";
import {
  createRoundcubeWebmailProfile,
  createSogoWebmailProfile,
  parseRoundcubeRows,
  parseSogoHeaders,
} from "./webmailProfiles.ts";

const access: StudyBuddyWebmailAccess = {
  transport: "webmail",
  sourceId: "mail-source",
  profileId: "fixture",
  baseUrl: "https://mail.example.edu/",
  username: "student@example.edu",
  password: "secret-kept-in-broker",
  folders: ["INBOX"],
};

function fixtureProfile(options: { restoreWorks?: boolean } = {}) {
  let seen = false;
  const calls: string[] = [];
  const session: WebmailProfileSession = { profileId: "fixture" };
  const profile: WebmailProviderProfile = {
    id: "fixture",
    readStateGuarantee: "verify-and-restore",
    login: vi.fn(async () => session),
    resolveSenderEmail: vi.fn(async () => "student@example.edu"),
    list: vi.fn(async (_session, input) => ({
      records: [
        {
          id: "42",
          folder: input.folder,
          subject: "Lab moved",
          from: [{ address: "office@example.edu" }],
          to: [{ address: "student@example.edu" }],
          isSeen: seen,
          hasAttachments: false,
        },
      ],
    })),
    inspectSeen: vi.fn(async () => {
      calls.push(`inspect:${seen}`);
      return seen;
    }),
    fetchRaw: vi.fn(async () => {
      calls.push("fetch:peek-contract-violated");
      // Model a provider regression: the supposedly non-mutating endpoint sets Seen.
      seen = true;
      return Buffer.from(
        'From: office@example.edu\r\nTo: student@example.edu\r\nSubject: Lab moved\r\nContent-Type: text/html\r\n\r\n<p>Room B4</p><img src="https://tracker.invalid/p">',
      );
    }),
    restoreSeen: vi.fn(async (_session, _reference, requested) => {
      calls.push(`restore:${requested}`);
      if (options.restoreWorks !== false) seen = requested;
    }),
    close: vi.fn(async () => undefined),
  };
  return { profile, calls, getSeen: () => seen };
}

describe("generic webmail read-state runtime", () => {
  it("detects a provider regression, restores Unseen, verifies it, then returns sanitized mail", async () => {
    const fixture = fixtureProfile();
    const runtime = createStudyBuddyWebmailRuntime({ profiles: [fixture.profile] });
    const page = await runtime.list(access, {});

    const result = await runtime.read(access, { messageId: page.messages[0]!.messageId });

    expect(fixture.calls).toEqual([
      "inspect:false",
      "fetch:peek-contract-violated",
      "inspect:true",
      "restore:false",
      "inspect:false",
    ]);
    expect(fixture.getSeen()).toBe(false);
    expect(result.seenState).toEqual({ seenBefore: false, seenAfter: false, preserved: true });
    expect(result.body.sanitizedHtml).toBe("<p>Room B4</p>");
    expect(result.body.sanitizedHtml).not.toContain("tracker.invalid");
  });

  it("fails closed and returns no message when restoration cannot be verified", async () => {
    const fixture = fixtureProfile({ restoreWorks: false });
    const runtime = createStudyBuddyWebmailRuntime({ profiles: [fixture.profile] });
    const page = await runtime.list(access, {});

    await expect(runtime.read(access, { messageId: page.messages[0]!.messageId })).rejects.toThrow(
      "restoration could not be verified",
    );
    expect(fixture.getSeen()).toBe(true);
  });

  it("tests a configured provider by exercising a real message preservation cycle", async () => {
    const fixture = fixtureProfile();
    const runtime = createStudyBuddyWebmailRuntime({ profiles: [fixture.profile] });

    const account = await runtime.test(access);

    expect(fixture.profile.fetchRaw).toHaveBeenCalledOnce();
    expect(fixture.profile.restoreSeen).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      false,
    );
    expect(fixture.getSeen()).toBe(false);
    expect(account).toEqual({ senderEmail: "student@example.edu" });
  });

  it("keeps the connection healthy when optional sender discovery is unavailable", async () => {
    const fixture = fixtureProfile();
    fixture.profile.resolveSenderEmail = vi.fn(async () => {
      throw new Error("provider does not expose account identity here");
    });
    const runtime = createStudyBuddyWebmailRuntime({ profiles: [fixture.profile] });

    await expect(runtime.test({ ...access, username: "student-login" })).resolves.toEqual({});
    expect(fixture.getSeen()).toBe(false);
  });

  it("fails closed for an unknown/unproven provider profile", async () => {
    const runtime = createStudyBuddyWebmailRuntime({ profiles: [] });
    await expect(runtime.list({ ...access, profileId: "other-webmail" }, {})).rejects.toThrow(
      "disabled until unread-state preservation is proven",
    );
  });
});

describe("official-provider response adapters", () => {
  it("parses SOGo header-table read state without message view endpoints", () => {
    const records = parseSogoHeaders(
      [
        ["Subject", "From", "To", "isRead", "hasAttachment", "uid"],
        [
          "Exam &amp; lab",
          [{ name: "Office", email: "office@example.edu" }],
          [{ name: "Student", email: "student@example.edu" }],
          "0",
          "1",
          "4711",
        ],
      ],
      "INBOX",
    );

    expect(records).toEqual([
      expect.objectContaining({
        id: "4711",
        subject: "Exam & lab",
        isSeen: false,
        hasAttachments: true,
      }),
    ]);
  });

  it("parses Roundcube JSON command rows as data without executing JavaScript", () => {
    const exec = [
      'this.add_message_row("42",{"subject":"Lab &amp; Exam","from":"Office &lt;office@example.edu&gt;","to":"student@example.edu"},{"seen":0,"attachment":1},false);',
      'this.display_message("ignored", "notice");',
    ].join("\n");

    const records = parseRoundcubeRows(exec, "INBOX", '{"page":1}');
    expect(records).toEqual([
      expect.objectContaining({
        id: "42",
        subject: "Lab & Exam",
        isSeen: false,
        hasAttachments: true,
      }),
    ]);
  });

  it("decodes each Roundcube entity layer only once", () => {
    const exec =
      'this.add_message_row("42",{"subject":"Lab &amp;nbsp; Exam","from":"office@example.edu"},{"seen":1},false);';

    const [record] = parseRoundcubeRows(exec, "INBOX", '{"page":1}');
    expect(record?.subject).toBe("Lab &nbsp; Exam");
  });

  it("uses only SOGo headers/export and explicit read-state remediation endpoints", async () => {
    const requests: Array<{ url: URL; method: string; headers: Headers }> = [];
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      requests.push({ url, method, headers });
      if (url.pathname.endsWith("/connect")) {
        return new Response('{"username":"student@example.edu"}', {
          headers: {
            "content-type": "application/json",
            "set-cookie": "XSRF-TOKEN=csrf-1; Secure",
          },
        });
      }
      if (url.pathname.endsWith("/view") || url.pathname.endsWith("/headers")) {
        const headerTable = [
          ["Subject", "From", "To", "isRead", "hasAttachment", "uid"],
          [
            "Lab",
            [{ name: "Office", email: "office@example.edu" }],
            [{ email: "student@example.edu" }],
            "0",
            "0",
            "42",
          ],
        ];
        return new Response(
          JSON.stringify(
            url.pathname.endsWith("/headers")
              ? headerTable
              : { headers: headerTable, uids: ["42"] },
          ),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname.endsWith("/mailAccounts")) {
        return new Response(
          JSON.stringify([
            {
              identities: [
                { email: "alias@example.edu", isDefault: false },
                { email: "student@example.edu", isDefault: true },
              ],
            },
          ]),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname.endsWith("/export")) {
        return new Response("From: office@example.edu\r\nSubject: Lab\r\n\r\nRoom B4");
      }
      if (url.pathname.endsWith("/markMessageUnread")) return new Response("{}");
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const profile = createSogoWebmailProfile({
      fetch: fetchMock,
      validateUrl: async () => undefined,
    });
    const session = await profile.login({
      ...access,
      profileId: "sogo",
      baseUrl: "https://mail.example.edu/SOGo/",
    });
    const page = await profile.list(session, { folder: "INBOX", limit: 1 });
    const reference = page.records[0]!;

    expect(await profile.resolveSenderEmail?.(session)).toBe("student@example.edu");
    expect(await profile.inspectSeen(session, reference)).toBe(false);
    expect((await profile.fetchRaw(session, reference)).toString()).toContain("Room B4");
    await profile.restoreSeen(session, reference, false);

    expect(requests.map(({ url, method }) => `${method} ${url.pathname}`)).toEqual([
      "POST /SOGo/connect",
      "POST /SOGo/so/student%40example.edu/Mail/0/folderINBOX/view",
      "GET /SOGo/so/student%40example.edu/Mail/mailAccounts",
      "POST /SOGo/so/student%40example.edu/Mail/0/folderINBOX/headers",
      "GET /SOGo/so/student%40example.edu/Mail/0/folderINBOX/42/export",
      "GET /SOGo/so/student%40example.edu/Mail/0/folderINBOX/42/markMessageUnread",
    ]);
    expect(requests.slice(1).every(({ headers }) => headers.get("x-xsrf-token") === "csrf-1")).toBe(
      true,
    );
  });

  it("uses Roundcube list/viewsource and mark-unread without calling message show", async () => {
    const requests: Array<{ url: URL; method: string; body?: string }> = [];
    const listPayload = JSON.stringify({
      env: { pagecount: 1 },
      exec: 'this.add_message_row("42",{"subject":"Lab","from":"office@example.edu","to":"student@example.edu"},{"seen":0},false);',
    });
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body instanceof URLSearchParams ? init.body.toString() : undefined;
      requests.push({ url, method, ...(body ? { body } : {}) });
      if (method === "GET" && !url.search) {
        return new Response('<input name="_token" value="login-token">', {
          headers: { "set-cookie": "roundcube_sessid=session-1; Secure" },
        });
      }
      if (method === "POST" && !url.search) {
        return new Response('<script>var x={"request_token":"mail-token"};</script>');
      }
      if (url.searchParams.get("_action") === "list") return new Response(listPayload);
      if (url.searchParams.get("_action") === "viewsource") {
        return new Response("From: office@example.edu\r\nSubject: Lab\r\n\r\nRoom B4");
      }
      if (url.searchParams.get("_action") === "mark") return new Response("{}");
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const profile = createRoundcubeWebmailProfile({
      fetch: fetchMock,
      validateUrl: async () => undefined,
    });
    const session = await profile.login({ ...access, profileId: "roundcube" });
    const page = await profile.list(session, { folder: "INBOX", limit: 1 });
    const reference = page.records[0]!;

    expect(await profile.inspectSeen(session, reference)).toBe(false);
    expect((await profile.fetchRaw(session, reference)).toString()).toContain("Room B4");
    await profile.restoreSeen(session, reference, false);

    const actions = requests.map(({ url }) => url.searchParams.get("_action")).filter(Boolean);
    expect(actions).toEqual(["list", "list", "viewsource", "mark"]);
    expect(actions).not.toContain("show");
    expect(requests.at(-1)?.body).toContain("_flag=unread");
  });
});
