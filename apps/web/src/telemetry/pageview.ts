const SAFE_SETTINGS_SECTIONS = new Set([
  "archived",
  "cloud",
  "connections",
  "diagnostics",
  "execution-profiles",
  "general",
  "keybindings",
  "privacy",
  "providers",
  "source-control",
  "study-buddy",
]);

export type PrivacySafeRoute =
  | "home"
  | "chat"
  | "/pair"
  | "/setup"
  | "/settings"
  | `/settings/${string}`
  | "application";

export interface PrivacySafePageviewProperties extends Readonly<Record<string, unknown>> {
  readonly route: PrivacySafeRoute;
  readonly $current_url: string;
}

/** Collapses dynamic application paths before they reach any analytics boundary. */
export function privacySafeRoute(pathname: string): PrivacySafeRoute {
  const cleanPathname = pathname.split(/[?#]/u, 1)[0] ?? "";
  if (cleanPathname === "/") return "home";
  if (cleanPathname.startsWith("/chat") || cleanPathname.startsWith("/_chat")) return "chat";
  if (cleanPathname.startsWith("/pair")) return "/pair";
  if (cleanPathname.startsWith("/setup")) return "/setup";
  if (cleanPathname.startsWith("/settings/")) {
    const section = cleanPathname.split("/")[2]?.toLowerCase();
    return section && SAFE_SETTINGS_SECTIONS.has(section)
      ? (`/settings/${section}` as const)
      : "/settings";
  }
  if (cleanPathname.startsWith("/settings")) return "/settings";
  return "application";
}

/** Builds PostHog-native pageview fields entirely from an allowlisted route category. */
export function privacySafePageviewProperties(pathname: string): PrivacySafePageviewProperties {
  const route = privacySafeRoute(pathname);
  const canonicalPath =
    route === "home"
      ? "/"
      : route === "chat"
        ? "/_chat/"
        : route === "application"
          ? "/application"
          : route;
  return {
    route,
    $current_url: `https://app.t3.codes${canonicalPath}`,
  };
}
