import type { StudyBuddyProfileIcon } from "@t3tools/contracts";
import {
  AtomIcon,
  BookOpenIcon,
  BrainIcon,
  CalculatorIcon,
  ChartNoAxesCombinedIcon,
  FlaskConicalIcon,
  GaugeIcon,
  GemIcon,
  GraduationCapIcon,
  LibraryIcon,
  LightbulbIcon,
  MicroscopeIcon,
  NotebookTabsIcon,
  PuzzleIcon,
  RocketIcon,
  TargetIcon,
  TelescopeIcon,
  WandSparklesIcon,
  WorkflowIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";

export const STUDY_BUDDY_PROFILE_ICON_OPTIONS: ReadonlyArray<{
  id: StudyBuddyProfileIcon;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "zap", label: "Fast", icon: ZapIcon },
  { id: "gauge", label: "Gauge", icon: GaugeIcon },
  { id: "gem", label: "Gem", icon: GemIcon },
  { id: "book-open", label: "Book", icon: BookOpenIcon },
  { id: "brain", label: "Brain", icon: BrainIcon },
  { id: "flask-conical", label: "Lab flask", icon: FlaskConicalIcon },
  { id: "graduation-cap", label: "Graduation", icon: GraduationCapIcon },
  { id: "calculator", label: "Calculator", icon: CalculatorIcon },
  { id: "chart", label: "Chart", icon: ChartNoAxesCombinedIcon },
  { id: "telescope", label: "Telescope", icon: TelescopeIcon },
  { id: "microscope", label: "Microscope", icon: MicroscopeIcon },
  { id: "atom", label: "Atom", icon: AtomIcon },
  { id: "lightbulb", label: "Idea", icon: LightbulbIcon },
  { id: "puzzle", label: "Puzzle", icon: PuzzleIcon },
  { id: "target", label: "Target", icon: TargetIcon },
  { id: "rocket", label: "Rocket", icon: RocketIcon },
  { id: "wand", label: "Wand", icon: WandSparklesIcon },
  { id: "library", label: "Library", icon: LibraryIcon },
  { id: "notebook", label: "Notebook", icon: NotebookTabsIcon },
  { id: "workflow", label: "Workflow", icon: WorkflowIcon },
];

const iconsById = new Map(
  STUDY_BUDDY_PROFILE_ICON_OPTIONS.map((option) => [option.id, option.icon]),
);

export function StudyBuddyProfileIconView(props: {
  icon: StudyBuddyProfileIcon | undefined;
  className?: string;
}) {
  const Icon = (props.icon && iconsById.get(props.icon)) || BookOpenIcon;
  return <Icon className={props.className} />;
}
