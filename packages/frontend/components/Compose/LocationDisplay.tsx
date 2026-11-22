import type React from 'react';
import { TouchableOpacity, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Card } from '@oxy.so/bloom/card';
import { useTranslation } from 'react-i18next';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiMapPinLine } from '@oxy.so/bloom/icons/RiMapPinLine';

import { Embed, HStack, Icon, Loading, RawText, toElement } from '@oxy.so/bloom-language';

interface LocationDisplayProps {
  location: {
    latitude: number;
    longitude: number;
    address?: string;
  } | null;
  onRemove: () => void;
  isGettingLocation?: boolean;
  style?: StyleProp<ViewStyle>;
}

export const LocationDisplay: React.FC<LocationDisplayProps> = ({
  location,
  onRemove,
  isGettingLocation = false,
  style,
}) => {
  const { t } = useTranslation();

  if (!location && !isGettingLocation) return null;

  return (
    <Card appearance="subtle" border="thin" radius="radius-8" style={[styles.container, style]}>
      {toElement(
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
                RawText(location?.address)
                  .grow()
                  .font('14')
                  .weight('medium')
                  .foreground('foreground'),
                Embed(
                  <TouchableOpacity onPress={onRemove}>
                    {toElement(Icon(RiCloseLine).size('sm').foreground('muted'))}
                  </TouchableOpacity>,
                ),
              ]),
        )
          .align('center')
          .spacing('sm'),
      )}
    </Card>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 12,
    marginTop: 8,
  },
});
