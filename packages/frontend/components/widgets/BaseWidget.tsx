import type { ReactNode } from 'react';
import { Divider } from '@oxy.so/bloom/divider';
import { Card, Embed, HStack, Text as LText, VStack, toElement } from '@oxy.so/bloom-language';

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
    toElement(
      Card(
        title
          ? HStack(
              LText(title).font('md').leading('24px').weight('bold').foreground('foreground'),
              icon ? VStack(Embed(icon)) : null,
            )
              .justify('between')
              .align('center')
          : null,
        VStack(Embed(children)),
        // The rule under a widget in a stacked rail: 8px of the card's
        // spacing plus this margin keep the 16px it always sat below.
        divider ? Embed(<Divider style={{ marginTop: 8 }} />) : null,
      )
        .style('plain')
        .radius('none')
        .spacing('sm')
        .margin('bottom', 'lg'),
    )
  );
}
