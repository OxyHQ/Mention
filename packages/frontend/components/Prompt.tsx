import React, { createContext, useCallback, useContext, useId, useMemo } from 'react';
import { View, Text, TouchableOpacity, type GestureResponderEvent, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '@/hooks/useTheme';
import type { ThemeColors } from '@/hooks/useTheme';
import * as Dialog from '@/components/Dialog';

export {
  type DialogControlProps as PromptControlProps,
  useDialogControl as usePromptControl,
} from '@/components/Dialog';

const PromptContext = createContext<{
  titleId: string;
  descriptionId: string;
}>({
  titleId: '',
  descriptionId: '',
});
PromptContext.displayName = 'PromptContext';

export function Outer({
  children,
  control,
  testID,
  onClose,
}: React.PropsWithChildren<{
  control: Dialog.DialogControlProps;
  testID?: string;
  onClose?: () => void;
}>) {
  const titleId = useId();
  const descriptionId = useId();

  const context = useMemo(
    () => ({ titleId, descriptionId }),
    [titleId, descriptionId],
  );

  return (
    <Dialog.Outer
      control={control}
      testID={testID}
      onClose={onClose}
      webOptions={{ alignCenter: true }}
      preventExpansion
    >
      <Dialog.Handle />
      <PromptContext.Provider value={context}>
        <Dialog.ScrollableInner
          label=""
          style={Platform.select({
            web: { maxWidth: 320, borderRadius: 36 },
            default: undefined,
          })}
        >
          {children}
        </Dialog.ScrollableInner>
      </PromptContext.Provider>
    </Dialog.Outer>
  );
}

export function TitleText({ children }: React.PropsWithChildren) {
  const { titleId } = useContext(PromptContext);
  return (
    <Text
      nativeID={titleId}
      className="text-2xl font-semibold text-foreground pb-1"
      style={{ lineHeight: 30 }}
    >
      {children}
    </Text>
  );
}

export function DescriptionText({
  children,
  selectable,
}: React.PropsWithChildren<{ selectable?: boolean }>) {
  const { descriptionId } = useContext(PromptContext);
  return (
    <Text
      nativeID={descriptionId}
      selectable={selectable}
      className="text-base text-muted-foreground pb-4"
      style={{ lineHeight: 22 }}
    >
      {children}
    </Text>
  );
}

export function Actions({ children }: { children: React.ReactNode }) {
  return <View className="w-full gap-2 justify-end">{children}</View>;
}

export function Content({ children }: { children: React.ReactNode }) {
  return <View className="pb-2">{children}</View>;
}

export type ActionColor = 'primary' | 'primary_subtle' | 'secondary' | 'negative' | 'negative_subtle';

function getActionColors(color: ActionColor, colors: ThemeColors) {
  switch (color) {
    case 'negative':
      return { background: colors.negative, foreground: colors.negativeForeground };
    case 'negative_subtle':
      return { background: colors.negativeSubtle, foreground: colors.negativeSubtleForeground };
    case 'primary_subtle':
      return { background: colors.primarySubtle, foreground: colors.primarySubtleForeground };
    case 'secondary':
      return { background: colors.contrast50, foreground: colors.text };
    case 'primary':
    default:
      return { background: colors.primary, foreground: '#FFFFFF' };
  }
}

export function Cancel({ cta }: { cta?: string }) {
  const { t } = useTranslation();
  const { close } = Dialog.useDialogContext();
  const theme = useTheme();
  const { background } = getActionColors('secondary', theme.colors);

  const onPress = useCallback(() => {
    close();
  }, [close]);

  return (
    <TouchableOpacity
      className="rounded-full items-center justify-center"
      style={{
        backgroundColor: background,
        paddingVertical: 12,
        paddingHorizontal: 24,
      }}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Text className="text-base font-medium text-foreground">
        {cta || t('common.cancel')}
      </Text>
    </TouchableOpacity>
  );
}

export function Action({
  onPress,
  color = 'primary',
  cta,
  disabled = false,
  shouldCloseOnPress = true,
  testID,
}: {
  onPress: (e: GestureResponderEvent) => void;
  color?: ActionColor;
  cta?: string;
  disabled?: boolean;
  shouldCloseOnPress?: boolean;
  testID?: string;
}) {
  const { t } = useTranslation();
  const { close } = Dialog.useDialogContext();
  const theme = useTheme();

  const handleOnPress = useCallback(
    (e: GestureResponderEvent) => {
      if (shouldCloseOnPress) {
        close(() => onPress?.(e));
      } else {
        onPress?.(e);
      }
    },
    [close, onPress, shouldCloseOnPress],
  );

  const { background, foreground } = getActionColors(color, theme.colors);

  return (
    <TouchableOpacity
      className="rounded-full items-center justify-center"
      style={{
        backgroundColor: background,
        opacity: disabled ? 0.5 : 1,
        paddingVertical: 12,
        paddingHorizontal: 24,
      }}
      onPress={handleOnPress}
      disabled={disabled}
      activeOpacity={0.7}
      testID={testID}
    >
      <Text className="text-base font-medium" style={{ color: foreground }}>
        {cta || t('common.confirm')}
      </Text>
    </TouchableOpacity>
  );
}

export function Basic({
  control,
  title,
  description,
  cancelButtonCta,
  confirmButtonCta,
  onConfirm,
  confirmButtonColor,
  showCancel = true,
}: React.PropsWithChildren<{
  control: Dialog.DialogOuterProps['control'];
  title: string;
  description?: string;
  cancelButtonCta?: string;
  confirmButtonCta?: string;
  onConfirm: (e: GestureResponderEvent) => void;
  confirmButtonColor?: ActionColor;
  showCancel?: boolean;
}>) {
  return (
    <Outer control={control} testID="confirmModal">
      <Content>
        <TitleText>{title}</TitleText>
        {description && <DescriptionText>{description}</DescriptionText>}
      </Content>
      <Actions>
        <Action
          cta={confirmButtonCta}
          onPress={onConfirm}
          color={confirmButtonColor}
          testID="confirmBtn"
        />
        {showCancel && <Cancel cta={cancelButtonCta} />}
      </Actions>
    </Outer>
  );
}
