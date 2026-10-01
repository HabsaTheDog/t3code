import { createLucideIcon, ShieldCheckIcon, ShieldQuestionMarkIcon } from "lucide-react";
import type { QuizAccessMode } from "../settings/StudyBuddySettings.logic";

const ShieldInfoIcon = createLucideIcon("ShieldInfo", [
  [
    "path",
    {
      d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
      key: "shield",
    },
  ],
  ["path", { d: "M12 11v6", key: "info-stem" }],
  ["path", { d: "M12 8h.01", key: "info-dot" }],
]);

export const quizAccessIcons = {
  "review-only": ShieldInfoIcon,
  "ask-before-attempt": ShieldQuestionMarkIcon,
  "quiz-assist": ShieldCheckIcon,
} satisfies Record<QuizAccessMode, typeof ShieldCheckIcon>;
