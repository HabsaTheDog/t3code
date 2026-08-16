import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_THEME, parseStoredTheme, resolveDesktopTheme, resolveTheme } from "./useTheme";

describe("Study Buddy theme", () => {
  it("is the deterministic default when no valid preference is stored", () => {
    expect(DEFAULT_THEME).toBe("study-buddy");
    expect(parseStoredTheme(null)).toBe("study-buddy");
    expect(parseStoredTheme("unknown")).toBe("study-buddy");
  });

  it("always resolves to the branded dark surface on every system preference", () => {
    expect(resolveTheme("study-buddy", false)).toBe("dark");
    expect(resolveTheme("study-buddy", true)).toBe("dark");
    expect(resolveDesktopTheme("study-buddy")).toBe("dark");
  });

  it("keeps the existing light, dark, and system choices available", () => {
    expect(parseStoredTheme("light")).toBe("light");
    expect(parseStoredTheme("dark")).toBe("dark");
    expect(parseStoredTheme("system")).toBe("system");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
  });
});
