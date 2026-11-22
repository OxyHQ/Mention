import type { ReactNode } from 'react';
import { Card } from '@oxy.so/bloom/card';
import { Divider } from '@oxy.so/bloom/divider';
import { Embed, HStack, Text as LText, VStack, toElement } from '@oxy.so/bloom-language';
import type { ViewStyle } from 'react-native';

// The widget's Card spaces its parts with a gap, which Bloom's Card takes as a style
// (the language's Card has no spacing); this draws its classes, `gap-2 mb-4`.
const widgetCard: ViewStyle = { gap: 8, marginBottom: 16 };

type BaseWidgetProps = {
  title?: string;
  icon?: ReactNode;
  divider?: boolean;
  children: ReactNode;
};

export function BaseWidget({ title, icon, divider, children }: BaseWidgetProps) {
  return (
    // The gap BELOW a widget belongs to the widget, not to the column that
    // holds it: a flex `gap` is charged per child regardless of the child's
    // height, so a rail whose widgets have all hidden themselves would still
    // reserve the spacing between them. Owning the margin here lets the
    // column collapse to nothing when every widget renders null.
    <Card appearance="plain" style={widgetCard} radius="radius-0">
      {title &&
        toElement(
          HStack(
            LText(title).font('md').leading('24px').weight('bold').foreground('foreground'),
            Embed(icon && toElement(VStack(Embed(icon)))),
          )
            .justify('between')
            .align('center'),
        )}
      {toElement(VStack(Embed(children)))}
      {/* The rule under a widget in a stacked rail: 8px of the card's
                gap plus this margin keep the 16px it always sat below. */}
      {divider ? <Divider style={{ marginTop: 8 }} /> : null}
    </Card>
  );
}
