import * as Option from "effect/Option";

export const DEFAULT_STUDY_BUDDY_DESKTOP_BACKEND_PORT = 13_773;

export function resolveConfiguredStudyBuddyBackendPort(input: {
  readonly isPackaged: boolean;
  readonly studyBuddyPort: Option.Option<number>;
  readonly legacyT3CodePort: Option.Option<number>;
}): Option.Option<number> {
  if (Option.isSome(input.studyBuddyPort)) return input.studyBuddyPort;
  return input.isPackaged ? Option.none() : input.legacyT3CodePort;
}
