import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MenuAction } from "@react-native-menu/menu";
import { describe, expect, it, vi } from "vitest";
import { NativePullDownMenu } from "@/platform/chrome/NativePullDownMenu";
import { palettes } from "@/theme/tokens";

const native = vi.hoisted(() => ({
  mode: "light" as "light" | "dark",
  actions: [] as MenuAction[],
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  NativeModules: {},
  UIManager: { getViewManagerConfig: () => ({}) },
}));
vi.mock("@/theme", async () => {
  const { palettes } = await import("@/theme/tokens");
  return { useTheme: () => ({ colors: palettes[native.mode] }) };
});
vi.mock("@react-native-menu/menu", () => ({
  MenuView: ({ actions }: { actions: MenuAction[] }) => {
    native.actions = actions;
    return null;
  },
}));

describe("native menu symbol colors", () => {
  it.each(["light", "dark"] as const)(
    "supplies visible colors to Fabric in %s mode",
    (mode) => {
      native.mode = mode;
      renderToStaticMarkup(
        createElement(NativePullDownMenu, {
          actions: [
            { id: "copy", title: "Copy", image: "link" },
            {
              id: "delete",
              title: "Delete",
              image: "trash",
              destructive: true,
              disabled: true,
            },
            {
              id: "more",
              title: "More",
              subactions: [
                {
                  id: "rewind",
                  title: "Rewind",
                  image: "arrow.uturn.backward",
                },
              ],
            },
          ],
          children: null,
          onAction: vi.fn(),
        }),
      );
      expect(native.actions[0]).toMatchObject({
        image: "link",
        imageColor: palettes[mode].textPrimary,
      });
      expect(native.actions[1]).toMatchObject({
        image: "trash",
        imageColor: palettes[mode].destructive,
        attributes: { destructive: true, disabled: true },
      });
      expect(native.actions[2].subactions?.[0]).toMatchObject({
        image: "arrow.uturn.backward",
        imageColor: palettes[mode].textPrimary,
      });
    },
  );
});

describe("Android PopupMenu action shape", () => {
  it("flattens inline groups behind a disabled group title and keeps one submenu level", async () => {
    const { ANDROID_MENU_GROUP_HEADER_SUFFIX, flattenAndroidMenuActions } =
      await import("@/platform/chrome/NativePullDownMenu");
    const flat = flattenAndroidMenuActions([
      {
        id: "group.sort",
        title: "Sort",
        displayInline: true,
        subactions: [
          { id: "sort.recent", title: "Recent", state: "on" },
          { id: "sort.name", title: "Name", state: "off", subtitle: "A-Z" },
        ],
      },
      {
        id: "group.untitled",
        title: "",
        displayInline: true,
        subactions: [{ id: "plain", title: "Plain" }],
      },
      {
        id: "more",
        title: "More",
        subactions: [
          {
            id: "inline",
            title: "Inline",
            displayInline: true,
            subactions: [{ id: "a", title: "A" }],
          },
          {
            id: "nested",
            title: "Nested",
            subactions: [{ id: "b", title: "B" }],
          },
        ],
      },
    ]);
    expect(flat.map((action) => action.id)).toEqual([
      `group.sort${ANDROID_MENU_GROUP_HEADER_SUFFIX}`,
      "sort.recent",
      "sort.name",
      "plain",
      "more",
    ]);
    expect(flat[0]).toMatchObject({ title: "Sort", disabled: true });
    expect(flat[1]).toMatchObject({ state: "on" });
    expect(flat[2]).toMatchObject({ title: "Name · A-Z", subtitle: undefined });
    expect(flat[4].subactions?.map((action) => action.id)).toEqual([
      `inline${ANDROID_MENU_GROUP_HEADER_SUFFIX}`,
      "a",
      `nested${ANDROID_MENU_GROUP_HEADER_SUFFIX}`,
      "b",
    ]);
    expect(flat[4].subactions?.every((action) => !action.subactions)).toBe(
      true,
    );
  });
});

describe("disabled triggers", () => {
  it("does not mount the native menu while the trigger is disabled", () => {
    native.actions = [];
    const html = renderToStaticMarkup(
      createElement(NativePullDownMenu, {
        actions: [{ id: "copy", title: "Copy" }],
        children: createElement("span", null, "trigger"),
        disabled: true,
        onAction: vi.fn(),
      }),
    );
    expect(html).toBe("<span>trigger</span>");
    expect(native.actions).toEqual([]);
  });
});
