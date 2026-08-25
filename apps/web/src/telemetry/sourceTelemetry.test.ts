import { describe, expect, it } from "vite-plus/test";

import {
  safeEmailProvider,
  sourceTelemetryProperties,
  telemetryCountBucket,
} from "./sourceTelemetry";

describe("privacy-safe source telemetry", () => {
  it("keeps only bounded source and provider categories", () => {
    const properties = sourceTelemetryProperties(
      {
        id: "private-source-id",
        label: "Alvaro's private university mailbox",
        kind: "email",
        enabled: true,
        connectionId: "private-connection-id",
        priority: 10,
        scope: {
          allowedOrigins: ["https://mail.private.example"],
          pathPrefixes: ["/private"],
          courseIds: [],
          mailFolders: ["INBOX"],
          tags: [],
        },
        capabilities: ["mail.message.read"],
        policy: {
          authenticatedReads: "allowed",
          downloads: "denied",
          remoteDrafts: "denied",
          emailSend: "denied",
        },
        health: { status: "connected" },
        revision: 1,
      },
      {
        connections: [
          {
            id: "private-connection-id",
            adapterId: "private-adapter-id",
            adapterVersion: "1",
            label: "Private connection",
            displayOrigin: "https://mail.private.example",
            entryPath: "/private",
            allowedOrigins: ["https://mail.private.example"],
            auth: { mode: "password", state: "configured", emailAddress: "private@example.com" },
            revision: 1,
          },
        ],
      },
    );

    expect(properties).toEqual({
      source_kind: "email",
      source_enabled: true,
      email_provider: "other",
    });
    expect(JSON.stringify(properties)).not.toContain("private");
  });

  it("allowlists provider categories and buckets counts", () => {
    expect(
      safeEmailProvider({
        id: "connection",
        adapterId: "sogo",
        adapterVersion: "1",
        label: "Mail",
        displayOrigin: "https://example.invalid",
        entryPath: "/",
        allowedOrigins: ["https://example.invalid"],
        auth: { mode: "password", state: "configured" },
        revision: 0,
      }),
    ).toBe("sogo");
    expect([0, 1, 5, 10, 25, 26].map(telemetryCountBucket)).toEqual([
      "0",
      "1",
      "2-5",
      "6-10",
      "11-25",
      "26+",
    ]);
  });
});
