// LOCAL ONLY (uncommitted): a lab screen for the Bloom language's SwiftUI layer on a device.
import { useState } from 'react';
import { View } from 'react-native';
import { RiDeleteBinLine, RiHeart3Line, RiPencilLine, RiShareLine, RiStarLine } from '@oxy.so/bloom/icons';
import {
  Button,
  ConfirmationDialog,
  GlassGroup,
  Header,
  HStack,
  Icon,
  Item,
  Text,
  ToolbarGroup,
  ToolbarSpacer,
  VStack,
  toElement,
  useNamespace,
} from '@oxy.so/bloom-language';

const STRIPES = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#9b5de5'];

export default function SwiftUILab() {
  const ns = useNamespace();
  const [erasing, setErasing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [chosen, setChosen] = useState('nothing yet');
  return (
    <View style={{ flex: 1, paddingTop: 48 }}>
      <View style={{ position: 'absolute', inset: 0, flexDirection: 'row' }} pointerEvents="none">
        {STRIPES.map((color) => (
          <View key={color} style={{ flex: 1, backgroundColor: color, opacity: 0.6 }} />
        ))}
      </View>
      {toElement(
        VStack(
          Header('Toolbar groups').toolbar(
            ToolbarGroup(Button(Icon(RiShareLine)).shape('circle').style('plain').label('Share')),
            ToolbarSpacer('fixed'),
            ToolbarGroup(
              Button(Icon(RiHeart3Line)).shape('circle').style('plain').label('Favorite'),
              Button(Icon(RiStarLine)).shape('circle').style('plain').label('Collect'),
            ),
          ),
          Text('Glass group: one base').font('headline').padding('horizontal', 'md'),
          HStack(
            GlassGroup(
              HStack(
                Button(Icon(RiPencilLine))
                  .shape('circle')
                  .style('plain')
                  .label('Draw')
                  .glass()
                  .glassID('pencil', ns)
                  .onPress(() => setErasing((on) => !on)),
                erasing
                  ? Button(Icon(RiDeleteBinLine))
                      .shape('circle')
                      .style('plain')
                      .label('Erase')
                      .glass()
                      .glassID('eraser', ns)
                  : null,
              ).spacing('xl'),
            ).blend('xl'),
          ).padding('horizontal', 'md'),
          Text(`Confirmation: ${chosen}`).font('headline').padding('horizontal', 'md'),
          HStack(
            Button(Text('Delete post'))
              .style('subtle')
              .tint('danger')
              .onPress(() => setAsking(true))
              .confirmationDialog(
                [asking, setAsking],
                ConfirmationDialog(
                  'Delete this post?',
                  Item('Delete').destructive().onPress(() => setChosen('Delete')),
                  Item('Archive instead').onPress(() => setChosen('Archive')),
                ).message('It cannot be undone.'),
              ),
          ).padding('horizontal', 'md'),
        ).spacing('xl'),
      )}
    </View>
  );
}
