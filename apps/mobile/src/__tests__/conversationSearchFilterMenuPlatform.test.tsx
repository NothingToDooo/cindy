import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ os: "ios" as "ios" | "android" }));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return runtime.os;
    },
  },
}));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/platform/chrome", () => ({ usesNativePullDownMenu: () => true }));

import { useConversationSearchFilterMenu } from "@/session/useConversationSearchFilterMenu";

function probe() {
  let result: ReturnType<typeof useConversationSearchFilterMenu> | undefined;
  function Probe() {
    result = useConversationSearchFilterMenu({
      activeCount: 0,
      agentKind: "all",
      lastActivity: "all",
      lockedProjects: false,
      onAgentKindChange: vi.fn(),
      onLastActivityChange: vi.fn(),
      onProjectsChange: vi.fn(),
      onReset: vi.fn(),
      onSortChange: vi.fn(),
      onStatusChange: vi.fn(),
      projectSelection: { kind: "all" },
      projects: [],
      sortBy: "recent",
      status: "active",
    } as never);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return result!;
}

describe("conversation search filter menu platform split", () => {
  it("uses the system pull-down on iOS, where multi-select keeps the menu open", () => {
    runtime.os = "ios";
    const menu = probe();
    expect(menu.filterActions?.length).toBeGreaterThan(0);
    expect(menu.onFilterAction).toBeTypeOf("function");
  });

  it("keeps the multi-select filter sheet on Android, whose PopupMenu closes on every tap", () => {
    runtime.os = "android";
    const menu = probe();
    expect(menu.filterActions).toBeUndefined();
    expect(menu.onFilterAction).toBeUndefined();
  });
});
