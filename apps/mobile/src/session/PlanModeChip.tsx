/**
 * PlanModeChip —— composer 工具排的计划模式激活指示(对照桌面 PR#494 PlanModeIndicator
 * 与 Cursor 的「Plan ×」chip)。计划模式不再体现在权限按钮 / 权限下拉位置,激活态由
 * 本 chip 表达;点 × 退出并恢复进入前的权限档。中性 chip token(与 GoalIndicator 同精神)。
 */
import { ListTodo, X } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/AppText';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

export interface PlanModeChipProps {
  onExit: () => void;
  disabled?: boolean;
  testID?: string;
  /** 复用同一 chip 表达其它一次性草稿模式(如新建任务的「协同」);缺省为计划模式。 */
  icon?: ReactNode;
  label?: string;
  exitAccessibilityLabel?: string;
  /** 点 chip 主体(非 ×)重新打开该模式的设置。 */
  onPress?: () => void;
}

export function PlanModeChip({ onExit, disabled, testID, icon, label, exitAccessibilityLabel, onPress }: PlanModeChipProps) {
  const styles = useThemedStyles(makeChipStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const body = (
    <>
      {icon ?? <ListTodo color={colors.textPrimary} size={iconSize.sm} strokeWidth={iconStroke.regular} />}
      <Text style={styles.label}>{label ?? t('interaction.planMode.label')}</Text>
    </>
  );
  return (
    <View style={styles.chip} testID={testID}>
      {onPress ? (
        <Pressable
          accessibilityLabel={label}
          accessibilityRole="button"
          disabled={disabled}
          hitSlop={4}
          onPress={onPress}
          style={({ pressed }) => [styles.body, pressed && styles.pressed]}
          testID={testID ? `${testID}.open` : undefined}
        >
          {body}
        </Pressable>
      ) : body}
      <Pressable
        accessibilityLabel={exitAccessibilityLabel ?? t('interaction.planMode.exit')}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        hitSlop={8}
        onPress={onExit}
        style={({ pressed }) => [styles.close, pressed && styles.pressed]}
        testID={testID ? `${testID}.exit` : undefined}
      >
        <X color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.bold} />
      </Pressable>
    </View>
  );
}

function makeChipStyles(colors: ThemeColors) {
  return {
    chip: {
      alignItems: 'center' as const,
      backgroundColor: colors.surfaceChip,
      borderRadius: radius.pill,
      flexDirection: 'row' as const,
      gap: spacing.xs,
      height: 28,
      paddingLeft: spacing.md,
      paddingRight: spacing.sm,
    },
    body: {
      alignItems: 'center' as const,
      flexDirection: 'row' as const,
      gap: spacing.xs,
    },
    label: {
      color: colors.textPrimary,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.medium,
    },
    close: {
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    pressed: {
      opacity: 0.6,
    },
  };
}
