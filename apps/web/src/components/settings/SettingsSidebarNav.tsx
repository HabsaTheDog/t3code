import { useCallback, type ComponentType } from "react";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BotIcon,
  CloudIcon,
  ExternalLinkIcon,
  GraduationCapIcon,
  GaugeIcon,
  GitBranchIcon,
  KeyboardIcon,
  Link2Icon,
  ShieldCheckIcon,
  Settings2Icon,
} from "lucide-react";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";

import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "../ui/sidebar";
import { Badge } from "../ui/badge";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";

export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/privacy"
  | "/settings/study-buddy"
  | "/settings/execution-profiles"
  | "/settings/source-control"
  | "/settings/cloud"
  | "/settings/connections"
  | "/settings/archived";

export const SETTINGS_NAV_ITEMS: ReadonlyArray<{
  label: string;
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
  badgeLabel?: string;
}> = [
  { label: "General", to: "/settings/general", icon: Settings2Icon },
  { label: "Study Buddy", to: "/settings/study-buddy", icon: GraduationCapIcon },
  { label: "Profile editor", to: "/settings/execution-profiles", icon: GaugeIcon },
  { label: "Privacy & data", to: "/settings/privacy", icon: ShieldCheckIcon },
  { label: "Keyboard shortcuts", to: "/settings/keybindings", icon: KeyboardIcon },
  { label: "AI connections", to: "/settings/providers", icon: BotIcon },
  { label: "Git & GitHub", to: "/settings/source-control", icon: GitBranchIcon },
  { label: "T3 Cloud", to: "/settings/cloud", icon: CloudIcon, badgeLabel: "Private Beta" },
  { label: "App connections", to: "/settings/connections", icon: Link2Icon },
  { label: "Archived chats", to: "/settings/archived", icon: ArchiveIcon },
];

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleSectionClick = useCallback(
    (to: SettingsSectionPath) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({ to, replace: true });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const handleBackClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, isMobile, navigate, setOpenMobile]);

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup className="px-2 py-3">
          <SidebarMenu>
            {SETTINGS_NAV_ITEMS.filter(
              (item) => item.to !== "/settings/cloud" || hasCloudPublicConfig(),
            ).map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.to;
              return (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    size="sm"
                    isActive={isActive}
                    className={
                      isActive
                        ? "gap-2.5 px-2.5 py-2 text-left text-[13px] font-medium text-foreground"
                        : "gap-2.5 px-2.5 py-2 text-left text-[13px] text-muted-foreground/70 hover:text-foreground/80"
                    }
                    onClick={() => handleSectionClick(item.to)}
                  >
                    <Icon
                      className={
                        isActive
                          ? "size-4 shrink-0 text-foreground"
                          : "size-4 shrink-0 text-muted-foreground/60"
                      }
                    />
                    <span className="truncate">{item.label}</span>
                    {item.badgeLabel ? (
                      <Badge variant="warning" size="sm" className="ml-auto">
                        {item.badgeLabel}
                      </Badge>
                    ) : null}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="gap-2 p-2">
        <div className="rounded-md border border-border/60 bg-muted/20 px-2.5 py-2">
          <p className="text-[9px] font-medium uppercase tracking-[0.14em] text-muted-foreground/60">
            Acknowledgements
          </p>
          <a
            className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            href="https://github.com/pingdotgg/t3code"
            rel="noopener noreferrer"
            target="_blank"
          >
            Built with T3 Code
            <ExternalLinkIcon className="size-3" aria-hidden="true" />
          </a>
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="gap-2 px-2 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={handleBackClick}
            >
              <ArrowLeftIcon className="size-4" />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
