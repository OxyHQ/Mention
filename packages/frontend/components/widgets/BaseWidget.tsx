import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Card } from '@oxy.so/bloom/card';
import { Divider } from '@oxy.so/bloom/divider';
import { Text } from '@oxy.so/bloom/typography';
import { createTokenStyles } from '@oxy.so/bloom/theme';

const useTextStyles = createTokenStyles(() => ({
  title: { fontSize: 15, lineHeight: 24, fontWeight: '700' },
}));

type BaseWidgetProps = {
  title?: string;
  icon?: ReactNode;
  divider?: boolean;
  children: ReactNode;
};

export function BaseWidget({ title, icon, divider, children }: BaseWidgetProps) {
  const textStyles = useTextStyles();
  return (
    // The gap BELOW a widget belongs to the widget, not to the column that
    // holds it: a flex `gap` is charged per child regardless of the child's
    // height, so a rail whose widgets have all hidden themselves would still
    // reserve the spacing between them. Owning the margin here lets the
    // column collapse to nothing when every widget renders null.
    <Card appearance="plain" style={{ gap: 8, marginBottom: 16 }} radius="radius-0">
      {title && (
        <View className="flex-row justify-between items-center">
          <Text style={textStyles.title}>{title}</Text>
          {icon && <View>{icon}</View>}
        </View>
      )}
      <View>{children}</View>
      {/* The rule under a widget in a stacked rail: 8px of the card's
                gap plus this margin keep the 16px it always sat below. */}
      {divider ? <Divider style={{ marginTop: 8 }} /> : null}
    </Card>
  );
}
