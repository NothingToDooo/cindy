import { MenuView, type MenuAction } from "@react-native-menu/menu";
import { type ReactNode } from "react";
import { NativeModules, Platform, UIManager } from "react-native";
import { useTheme, type ThemeColors } from "@/theme";

export type NativePullDownAction = {
  disabled?: boolean;
  destructive?: boolean;
  displayInline?: boolean;
  id: string;
  image?: MenuAction["image"];
  keepPresented?: boolean;
  preferredElementSize?: "small" | "medium" | "large";
  state?: "on" | "off" | "mixed";
  subactions?: NativePullDownAction[];
  subtitle?: string;
  title: string;
};

let nativePullDownAvailable: boolean | null = null;

/**
 * 当前包里已经编进 MenuView 时才挂原生菜单:iOS 是 UIMenu,Android 是系统
 * PopupMenu(同一个库,两端交互一致:贴着触发控件弹出、点选即收起)。没有该
 * 原生视图的旧包自动退回自绘。
 */
export function usesNativePullDownMenu(): boolean {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return false;
  if (nativePullDownAvailable !== null) return nativePullDownAvailable;
  const config = UIManager.getViewManagerConfig?.("MenuView");
  nativePullDownAvailable = Boolean(config || NativeModules.MenuView);
  return nativePullDownAvailable;
}

/** 展平后分组标题行的 id 后缀;该行禁用,不会触发 onAction。 */
export const ANDROID_MENU_GROUP_HEADER_SUFFIX = ".__groupHeader";

/**
 * Android PopupMenu 没有 UIMenu 的内联分组和副标题,且子菜单不能再嵌子菜单。
 * 内联分组展平进所在层级(与 iOS 同一层即可点选),并用一行禁用的组名代替 UIMenu
 * 的分组标题,避免多个「全部」失去上下文;副标题接在标题后;普通子菜单只保留一级。
 */
export function flattenAndroidMenuActions(
  actions: readonly NativePullDownAction[],
  depth = 0,
): NativePullDownAction[] {
  return actions.flatMap((action) => {
    const inlineGroup = action.displayInline || depth > 0;
    if (inlineGroup && action.subactions?.length) {
      const header: NativePullDownAction[] = action.title.trim()
        ? [
            {
              disabled: true,
              id: `${action.id}${ANDROID_MENU_GROUP_HEADER_SUFFIX}`,
              title: action.title,
            },
          ]
        : [];
      return [
        ...header,
        ...flattenAndroidMenuActions(action.subactions, depth),
      ];
    }
    const leaf: NativePullDownAction = action.subtitle
      ? {
          ...action,
          subtitle: undefined,
          title: `${action.title} · ${action.subtitle}`,
        }
      : action;
    if (!action.subactions?.length) return [leaf];
    return [
      {
        ...leaf,
        subactions: flattenAndroidMenuActions(action.subactions, depth + 1),
      },
    ];
  });
}

function toMenuAction(
  action: NativePullDownAction,
  colors: ThemeColors,
): MenuAction {
  const android = Platform.OS === "android";
  return {
    id: action.id,
    title: action.title,
    // Fabric defaults the library's optional Int32 imageColor to transparent.
    // Always pair a symbol with a visible semantic color. Android resolves
    // `image` as a drawable name, so SF Symbol names are iOS-only.
    ...(action.image && !android
      ? {
          image: action.image,
          imageColor: action.destructive
            ? colors.destructive
            : colors.textPrimary,
        }
      : {}),
    ...(action.subtitle ? { subtitle: action.subtitle } : {}),
    ...(action.state ? { state: action.state } : {}),
    ...(action.displayInline ? { displayInline: true } : {}),
    ...(action.preferredElementSize
      ? { preferredElementSize: action.preferredElementSize }
      : {}),
    ...(action.destructive || action.disabled || action.keepPresented
      ? {
          attributes: {
            ...(action.destructive ? { destructive: true } : {}),
            ...(action.disabled ? { disabled: true } : {}),
            ...(action.keepPresented ? { keepsMenuPresented: true } : {}),
          },
        }
      : {}),
    ...(action.subactions?.length
      ? {
          subactions: action.subactions.map((item) =>
            toMenuAction(item, colors),
          ),
        }
      : {}),
  };
}

/**
 * 收起时完全是调用方原来的按钮/标题;iOS 点开是系统 UIMenu 下拉,Android 是
 * 系统 PopupMenu。尚未编进 MenuView 的包只渲染 children,由调用方继续走自绘面板。
 */
export function NativePullDownMenu({
  actions,
  children,
  disabled = false,
  longPress = false,
  onAction,
  testID,
}: {
  actions: readonly NativePullDownAction[];
  children: ReactNode;
  /**
   * 触发控件禁用时不挂菜单:MenuView 自己接管点按(Android 拦截全部触摸),不会看子
   * 控件的 disabled,挂着就会照样弹出。
   */
  disabled?: boolean;
  longPress?: boolean;
  onAction(id: string): void;
  testID?: string;
}) {
  const { colors } = useTheme();
  if (disabled || !usesNativePullDownMenu()) return children;
  const menuActions =
    Platform.OS === "android" ? flattenAndroidMenuActions(actions) : actions;
  return (
    <MenuView
      actions={menuActions.map((action) => toMenuAction(action, colors))}
      onPressAction={({ nativeEvent }) => {
        const id = nativeEvent.event;
        if (id && !id.endsWith(ANDROID_MENU_GROUP_HEADER_SUFFIX)) onAction(id);
      }}
      shouldOpenOnLongPress={longPress}
      testID={testID}
    >
      {children}
    </MenuView>
  );
}
