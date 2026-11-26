// LOCAL ONLY (uncommitted): a lab screen for the Bloom language's glass groups on Android (blend, union, glassID).
import { useState } from 'react';
import { View } from 'react-native';
import { RiDeleteBinLine, RiHeart3Line, RiPencilLine, RiShareLine, RiStarLine } from '@oxy.so/bloom/icons';
import { Button, GlassGroup, HStack, Icon, Text, VStack, toElement, useNamespace } from '@oxy.so/bloom-language';

const STRIPES = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#9b5de5'];
const SLOTS = [RiHeart3Line, RiStarLine, RiShareLine];

export default function GlassLab() {
  const ns = useNamespace();
  const [erasing, setErasing] = useState(false);
  const [selected, setSelected] = useState(0);
  const glyph = (icon: typeof RiPencilLine, label: string) =>
    Button(Icon(icon)).shape('circle').style('plain').label(label).glass();
  return (
    <View style={{ flex: 1, paddingTop: 60 }}>
      <View style={{ position: 'absolute', inset: 0, flexDirection: 'row' }} pointerEvents="none">
        {STRIPES.map((color) => (
          <View key={color} style={{ flex: 1, backgroundColor: color, opacity: 0.6 }} />
        ))}
      </View>
      {toElement(
        VStack(
          Text('Blend at rest').font('headline'),
          GlassGroup(
            HStack(glyph(RiHeart3Line, 'g1'), glyph(RiStarLine, 'g2'), glyph(RiShareLine, 'g3')).spacing('xs'),
          ).blend('xl'),
          Text('Union: the first two are one shape').font('headline'),
          GlassGroup(
            HStack(
              glyph(RiHeart3Line, 'u1').glassUnion('pair', ns),
              glyph(RiStarLine, 'u2').glassUnion('pair', ns),
              glyph(RiShareLine, 'u3'),
            ).spacing('xl'),
          ),
          Text(`glassID moves: ${selected}`).font('headline'),
          GlassGroup(
            HStack(
              ...SLOTS.map((icon, slot) => {
                const button = Button(Icon(icon)).shape('circle').style('plain').label(`slot ${slot}`);
                return slot === selected ? button.glass().glassID('selected', ns) : button;
              }),
            ).spacing('3xl'),
          )
            .blend('md')
            .animation('expand', selected),
          Text('Pencil and eraser').font('headline'),
          GlassGroup(
            HStack(
              glyph(RiPencilLine, 'Draw').glassID('pencil', ns),
              erasing ? glyph(RiDeleteBinLine, 'Erase').glassID('eraser', ns) : null,
            ).spacing('xl'),
          )
            .blend('xl')
            .animation('expand', erasing),
          HStack(
            Button(Text('lab move')).style('subtle').onPress(() => setSelected((value) => (value + 1) % 3)),
            Button(Text('lab erase')).style('subtle').onPress(() => setErasing((on) => !on)),
          ).spacing('md'),
        )
          .spacing('xl')
          .padding('horizontal', 'lg'),
      )}
    </View>
  );
}
