import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import {
  BrainCircuitIcon,
  EllipsisIcon,
  ListTodoIcon,
  LockIcon,
  LockOpenIcon,
  MessageCircleIcon,
  MonitorCogIcon,
  PenLineIcon,
  ShieldCheckIcon,
} from "lucide-react";
import {
  isQuizAccessMode,
  QUIZ_ACCESS_MODE_OPTIONS,
  type QuizAccessMode,
} from "../settings/StudyBuddySettings.logic";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";

const runtimeModeOptions: ReadonlyArray<{
  value: RuntimeMode;
  label: string;
  icon: typeof LockIcon;
}> = [
  { value: "approval-required", label: "Supervised", icon: LockIcon },
  { value: "auto-accept-edits", label: "Auto-accept edits", icon: PenLineIcon },
  { value: "full-access", label: "Full access", icon: LockOpenIcon },
];

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  interactionMode: ProviderInteractionMode;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  quizAccessMode: QuizAccessMode;
  quizAccessDisabled: boolean;
  runtimeMode: RuntimeMode;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  onToggleInteractionMode: () => void;
  onTogglePlanSidebar: () => void;
  onQuizAccessModeChange: (mode: QuizAccessMode) => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-48">
        {props.traitsMenuContent ? (
          <MenuSub>
            <MenuSubTrigger>
              <BrainCircuitIcon className="size-4 text-muted-foreground" />
              Reasoning
            </MenuSubTrigger>
            <MenuSubPopup className="min-w-44">{props.traitsMenuContent}</MenuSubPopup>
          </MenuSub>
        ) : null}
        {props.showInteractionModeToggle ? (
          <MenuSub>
            <MenuSubTrigger>
              <MessageCircleIcon className="size-4 text-muted-foreground" />
              Mode
            </MenuSubTrigger>
            <MenuSubPopup className="min-w-40">
              <MenuRadioGroup
                value={props.interactionMode}
                onValueChange={(value) => {
                  if (!value || value === props.interactionMode) return;
                  props.onToggleInteractionMode();
                }}
              >
                <MenuRadioItem value="default">
                  <span className="flex items-center gap-2">
                    <MessageCircleIcon className="size-4 text-muted-foreground" />
                    Chat
                  </span>
                </MenuRadioItem>
                <MenuRadioItem value="plan">
                  <span className="flex items-center gap-2">
                    <ListTodoIcon className="size-4 text-muted-foreground" />
                    Plan
                  </span>
                </MenuRadioItem>
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
        ) : null}
        <MenuSub>
          <MenuSubTrigger>
            <MonitorCogIcon className="size-4 text-muted-foreground" />
            Computer access
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-52">
            <MenuRadioGroup
              value={props.runtimeMode}
              onValueChange={(value) => {
                if (!value || value === props.runtimeMode) return;
                props.onRuntimeModeChange(value as RuntimeMode);
              }}
            >
              {runtimeModeOptions.map((option) => {
                const OptionIcon = option.icon;
                return (
                  <MenuRadioItem key={option.value} value={option.value}>
                    <span className="flex items-center gap-2">
                      <OptionIcon className="size-4 text-muted-foreground" />
                      {option.label}
                    </span>
                  </MenuRadioItem>
                );
              })}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger disabled={props.quizAccessDisabled}>
            <ShieldCheckIcon className="size-4 text-muted-foreground" />
            Quiz access
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-52">
            <MenuRadioGroup
              value={props.quizAccessMode}
              onValueChange={(value) => {
                if (!isQuizAccessMode(value) || value === props.quizAccessMode) return;
                props.onQuizAccessModeChange(value);
              }}
            >
              {QUIZ_ACCESS_MODE_OPTIONS.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  <span className="flex items-center gap-2">
                    <ShieldCheckIcon className="size-4 text-muted-foreground" />
                    {option.label}
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        {props.activePlan ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onTogglePlanSidebar}>
              <ListTodoIcon className="size-4 shrink-0" />
              {props.planSidebarOpen
                ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
                : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
