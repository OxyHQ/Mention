import { useTranslation } from 'react-i18next';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiMapPinLine } from '@oxy.so/bloom/icons/RiMapPinLine';

import {
  Card,
  HStack,
  Icon,
  Loading,
  RawText,
  VStack,
  type ViewModifier,
  view,
} from '@oxy.so/bloom-language';

interface LocationDisplayProps {
  location: {
    latitude: number;
    longitude: number;
    address?: string;
  } | null;
  onRemove: () => void;
  isGettingLocation?: boolean;
  /** Where the caller places the card (the composer's inset under the text). */
  look?: ViewModifier;
}

export const LocationDisplay = view(function LocationDisplay({
  location,
  onRemove,
  isGettingLocation = false,
  look,
}: LocationDisplayProps) {
  const { t } = useTranslation();

  if (!location && !isGettingLocation) return null;

  return Card(
    HStack(
      Icon(RiMapPinLine).size('sm').foreground('primary'),
      ...(isGettingLocation
        ? [
            Loading().size('sm'),
            RawText(t('compose.location.getting', { defaultValue: 'Getting location...' }))
              .grow()
              .font('14')
              .weight('medium')
              .foreground('muted'),
          ]
        : [
            RawText(location?.address).grow().font('14').weight('medium').foreground('foreground'),
            VStack(Icon(RiCloseLine).size('sm').foreground('muted')).onPress(onRemove).pressFade(),
          ]),
    )
      .align('center')
      .spacing('sm'),
  )
    .style('subtle')
    .outline('thin')
    .radius('sm')
    .padding('md')
    .margin('top', 'sm')
    .modifier(look);
});
