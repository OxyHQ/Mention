import type React from 'react';
import { Text, TouchableOpacity, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Card } from '@oxy.so/bloom/card';
import { Loading } from '@oxy.so/bloom/loading';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiMapPinLine } from '@oxy.so/bloom/icons/RiMapPinLine';

import { Embed, HStack, Icon, toElement } from '@oxy.so/bloom-language';

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
  const theme = useTheme();
  const { t } = useTranslation();

  if (!location && !isGettingLocation) return null;

  return (
    <Card appearance="subtle" border="thin" radius="radius-8" style={[styles.container, style]}>
      {toElement(
        HStack(
          Icon(RiMapPinLine).size('sm').foreground('primary'),
          Embed(
            isGettingLocation ? (
              <>
                <Loading className="text-primary" size="sm" style={{ flex: undefined }} />
                <Text style={[styles.text, { color: theme.colors.textSecondary }]}>
                  {t('compose.location.getting', { defaultValue: 'Getting location...' })}
                </Text>
              </>
            ) : (
              <>
                <Text style={[styles.text, { color: theme.colors.text }]}>{location?.address}</Text>
                <TouchableOpacity onPress={onRemove}>
                  {toElement(Icon(RiCloseLine).size('sm').foreground('muted'))}
                </TouchableOpacity>
              </>
            ),
          ),
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  text: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
  },
});
