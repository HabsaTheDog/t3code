import "../../index.css";

import { page } from "vite-plus/test/browser";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  SIDEBAR_QUICK_CHAT_PANE_RATIO_STORAGE_KEY,
  SidebarSectionSplitPane,
} from "./SidebarSectionSplitPane";

function renderSplitPane() {
  return render(
    <div className="flex h-[600px] flex-col">
      <SidebarSectionSplitPane
        quickChats={<div>Quick Chat content</div>}
        projects={<div>Project content</div>}
      />
    </div>,
  );
}

describe("SidebarSectionSplitPane", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders independently bounded Quick Chat and project panes", async () => {
    await renderSplitPane();

    await expect.element(page.getByTestId("quick-chat-pane")).toBeVisible();
    await expect.element(page.getByTestId("projects-pane")).toBeVisible();
    const separator = page.getByRole("separator", {
      name: "Resize Quick Chats and Projects",
    });
    await expect.element(separator).toHaveAttribute("aria-valuemin", "20");
    await expect.element(separator).toHaveAttribute("aria-valuemax", "75");
    await expect.element(separator).toHaveAttribute("aria-valuenow", "40");
  });

  it("restores the saved ratio and supports keyboard resizing and reset", async () => {
    window.localStorage.setItem(SIDEBAR_QUICK_CHAT_PANE_RATIO_STORAGE_KEY, "0.6");
    await renderSplitPane();

    const separator = page.getByRole("separator", {
      name: "Resize Quick Chats and Projects",
    });
    await expect.element(separator).toHaveAttribute("aria-valuenow", "60");
    const separatorElement = await separator.element();
    separatorElement.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    await expect.element(separator).toHaveAttribute("aria-valuenow", "65");
    expect(window.localStorage.getItem(SIDEBAR_QUICK_CHAT_PANE_RATIO_STORAGE_KEY)).toBe("0.65");

    separatorElement.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await expect.element(separator).toHaveAttribute("aria-valuenow", "40");
    expect(window.localStorage.getItem(SIDEBAR_QUICK_CHAT_PANE_RATIO_STORAGE_KEY)).toBe("0.4");
  });

  it("updates and persists the ratio after a pointer drag", async () => {
    await renderSplitPane();

    const splitPane = (await page
      .getByTestId("sidebar-section-split-pane")
      .element()) as HTMLDivElement;
    vi.spyOn(splitPane, "getBoundingClientRect").mockReturnValue({
      bottom: 600,
      height: 500,
      left: 0,
      right: 280,
      top: 100,
      width: 280,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });
    const separator = page.getByRole("separator", {
      name: "Resize Quick Chats and Projects",
    });
    const separatorElement = (await separator.element()) as HTMLDivElement;
    separatorElement.setPointerCapture = vi.fn();
    separatorElement.hasPointerCapture = () => false;

    separatorElement.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 7, clientY: 300 }),
    );
    separatorElement.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 7, clientY: 350 }),
    );
    await expect.element(separator).toHaveAttribute("aria-valuenow", "50");
    separatorElement.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 7, clientY: 350 }),
    );

    expect(window.localStorage.getItem(SIDEBAR_QUICK_CHAT_PANE_RATIO_STORAGE_KEY)).toBe("0.5");
  });
});
