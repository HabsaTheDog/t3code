import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  DEFAULT_STUDY_BUDDY_DESKTOP_BACKEND_PORT,
  resolveConfiguredStudyBuddyBackendPort,
} from "./DesktopPortPolicy.ts";

describe("Study Buddy desktop port policy", () => {
  it("uses a dedicated default outside T3 Code's 3773 range", () => {
    assert.equal(DEFAULT_STUDY_BUDDY_DESKTOP_BACKEND_PORT, 13_773);
  });

  it("ignores a legacy T3CODE_PORT override in packaged Study Buddy", () => {
    assert.deepEqual(
      resolveConfiguredStudyBuddyBackendPort({
        isPackaged: true,
        studyBuddyPort: Option.none(),
        legacyT3CodePort: Option.some(3773),
      }),
      Option.none(),
    );
  });

  it("honors the Study Buddy-specific override in packaged builds", () => {
    assert.deepEqual(
      resolveConfiguredStudyBuddyBackendPort({
        isPackaged: true,
        studyBuddyPort: Option.some(14_001),
        legacyT3CodePort: Option.some(3773),
      }),
      Option.some(14_001),
    );
  });

  it("retains T3CODE_PORT compatibility for development", () => {
    assert.deepEqual(
      resolveConfiguredStudyBuddyBackendPort({
        isPackaged: false,
        studyBuddyPort: Option.none(),
        legacyT3CodePort: Option.some(4949),
      }),
      Option.some(4949),
    );
  });
});
