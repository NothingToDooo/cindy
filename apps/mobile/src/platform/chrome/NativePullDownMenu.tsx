import { MenuView, type MenuAction } from "@react-native-menu/menu";
import { type ReactNode } from "react";
import { NativeModules, Platform, UIManager } from "react-native";
import { AnchoredPullDownMenu } from "@/platform/chrome/AnchoredPullDownMenu";
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
 * 是否用「贴着触发控件弹出」的菜单:iOS 在包里编进 MenuView 时用系统 UIMenu(没冷更前
 * 自动退回调用方的自绘面板);Android 始终用 Cindy 自绘的 AnchoredPullDownMenu。
 */
export function usesNativePullDownMenu(): boolean {
  if (Platform.OS === "android") return true;
  if (Platform.OS !== "ios") return false;
  if (nativePullDownAvailable !== null) return nativePullDownAvailable;
  const config = UIManager.getViewManagerConfig?.("MenuView");
  nativePullDownAvailable = Boolean(config || NativeModules.MenuView);
  return nativePullDownAvailable;
}

function toMenuAction(
  action: NativePullDownAction,
  colors: ThemeColors,
): MenuAction {
  return {
    id: action.id,
    title: action.title,
    // Fabric defaults the library's optional Int32 imageColor to transparent.
    // Always pair a symbol with a visible semantic color.
    ...(action.image
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
 * 收起时完全是调用方原来的按钮/标题;iOS 点开是系统 UIMenu 下拉,Android 是 Cindy 自绘
 * 的同交互菜单(AnchoredPullDownMenu)。iOS 尚未编进 MenuView 的包只渲染 children,
 * 由调用方继续走自绘面板。
 */
export function NativePullDownMenu({
  accessibilityLabel,
  actions,
  children,
  disabled = false,
  longPress = false,
  onAction,
  testID,
}: {
  /** Android 触发器整块作为一个读屏按钮;不传时取子元素的 accessibilityLabel。 */
  accessibilityLabel?: string;
  actions: readonly NativePullDownAction[];
  children: ReactNode;
  /** 触发控件禁用时不挂菜单:菜单接管整块点按,不会看子控件的 disabled。 */
  disabled?: boolean;
  longPress?: boolean;
  onAction(id: string): void;
  testID?: string;
}) {
  const { colors } = useTheme();
  if (disabled || !usesNativePullDownMenu()) return children;
  if (Platform.OS === "android") {
    return (
      <AnchoredPullDownMenu
        accessibilityLabel={accessibilityLabel}
        actions={actions}
        longPress={longPress}
        onAction={onAction}
        testID={testID}
      >
        {children}
      </AnchoredPullDownMenu>
    );
  }
  return (
    <MenuView
      actions={actions.map((action) => toMenuAction(action, colors))}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event) onAction(nativeEvent.event);
      }}
      shouldOpenOnLongPress={longPress}
      testID={testID}
    >
      {children}
    </MenuView>
  );
}
