import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MenuAction } from "@react-native-menu/menu";
import { describe, expect, it, vi } from "vitest";
import { NativePullDownMenu } from "@/platform/chrome/NativePullDownMenu";
import { palettes } from "@/theme/tokens";

const native = vi.hoisted(() => ({
  mode: "light" as "light" | "dark",
  actions: [] as MenuAction[],
  style: undefined as unknown,
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
vi.mock("@/platform/chrome/AnchoredPullDownMenu", () => ({
  AnchoredPullDownMenu: () => null,
}));
vi.mock("@react-native-menu/menu", () => ({
  MenuView: ({ actions, style }: { actions: MenuAction[]; style?: unknown }) => {
    native.actions = actions;
    native.style = style;
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

  it("honors a trigger that marks itself disabled", () => {
    native.actions = [];
    const html = renderToStaticMarkup(
      createElement(NativePullDownMenu, {
        actions: [{ id: "clear", title: "Clear" }],
        children: createElement("button", { disabled: true }, "options"),
        onAction: vi.fn(),
      }),
    );
    expect(html).toBe('<button disabled="">options</button>');
    expect(native.actions).toEqual([]);
  });
});

describe("trigger layout", () => {
  it("hands the caller's layout style to the menu wrapper", () => {
    const style = { flex: 1, minWidth: 0 };
    renderToStaticMarkup(
      createElement(NativePullDownMenu, {
        actions: [{ id: "all", title: "All" }],
        children: createElement("span", null, "title"),
        onAction: vi.fn(),
        style,
      }),
    );
    expect(native.style).toBe(style);
  });
});

describe("empty menus", () => {
  it("does not mount a menu that has nothing to choose", () => {
    native.actions = [];
    const html = renderToStaticMarkup(
      createElement(NativePullDownMenu, {
        actions: [],
        children: createElement("span", null, "display"),
        onAction: vi.fn(),
      }),
    );
    expect(html).toBe("<span>display</span>");
  });
});
