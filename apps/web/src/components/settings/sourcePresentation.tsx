import type {
  StudyBuddySourceCapability,
  StudyBuddySourceHealth,
  StudyBuddySourceKind,
} from "@t3tools/contracts";
import {
  CalendarDaysIcon,
  Globe2Icon,
  GraduationCapIcon,
  LibraryIcon,
  MailIcon,
} from "lucide-react";

export const SOURCE_KIND_PRESENTATION: Record<
  StudyBuddySourceKind,
  { label: string; description: string; icon: typeof Globe2Icon }
> = {
  "moodle-course": {
    label: "Moodle course",
    description: "Courses, files, and learning activities from Moodle.",
    icon: GraduationCapIcon,
  },
  calendar: {
    label: "Calendar",
    description: "Classes, exams, rooms, and deadlines from your calendar.",
    icon: CalendarDaysIcon,
  },
  website: {
    label: "Website",
    description: "A public or password-protected website with useful study information.",
    icon: Globe2Icon,
  },
  "resource-portal": {
    label: "Resource portal",
    description: "Books, readings, and other study resources from one website.",
    icon: LibraryIcon,
  },
  email: {
    label: "Email",
    description: "Let Study Buddy read university email when you ask about it.",
    icon: MailIcon,
  },
};

const CAPABILITY_LABELS: Record<StudyBuddySourceCapability, string> = {
  "content.search": "Search",
  "content.list": "Browse",
  "content.read": "Read",
  "content.download": "Files",
  "calendar.events.read": "Events",
  "course.structure.read": "Courses",
  "quiz.completed-attempt.read": "Quiz review",
  "mail.threads.list": "Inbox",
  "mail.message.read": "Messages",
  "mail.attachment.read": "Attachments",
  "mail.draft.local": "Prepare drafts",
  "mail.draft.remote": "Save drafts",
  "mail.send": "Ask to send",
};

export function capabilityLabel(capability: StudyBuddySourceCapability) {
  return CAPABILITY_LABELS[capability];
}

export function healthLabel(health: StudyBuddySourceHealth) {
  switch (health.status) {
    case "connected":
      return "Connected";
    case "action-required":
      return "Sign-in needed";
    case "expired":
      return "Sign-in expired";
    case "failed":
      return "Connection failed";
    default:
      return "Not checked";
  }
}
