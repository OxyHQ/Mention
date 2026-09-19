import React, { useMemo } from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { RiStarFill } from '@oxy.so/bloom/icons/RiStarFill';
import { RiStarLine } from '@oxy.so/bloom/icons/RiStarLine';

interface StarRatingProps {
  rating: number;
  size?: number;
  color: string;
  interactive?: boolean;
  onRate?: (value: number) => void;
}

const StarRating = React.memo(function StarRating({
  rating,
  size = 16,
  color,
  interactive = false,
  onRate,
}: StarRatingProps) {
  const stars = useMemo(
    () =>
      Array.from({ length: 5 }, (_, i) => ({
        key: i,
        Star: (interactive ? i < rating : i < Math.round(rating)) ? RiStarFill : RiStarLine,
      })),
    [rating, interactive]
  );

  return (
    <View style={styles.row}>
      {stars.map(({ key, Star }) =>
        interactive ? (
          <TouchableOpacity
            key={key}
            onPress={() => onRate?.(key + 1)}
            // Asymmetric on purpose: the stars sit side by side, so the
            // horizontal slop stays under half the gap between them — a
            // symmetric one would let each star swallow its neighbour's taps
            // and rate the wrong value.
            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
          >
            <Star width={size} fill={color} />
          </TouchableOpacity>
        ) : (
          <Star key={key} width={size} fill={color} />
        )
      )}
    </View>
  );
});

export default StarRating;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 1,
  },
});
