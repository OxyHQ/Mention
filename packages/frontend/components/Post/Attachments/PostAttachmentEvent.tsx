import React from 'react';
import { TouchableOpacity, View, Text, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '@/hooks/useTheme';

interface PostAttachmentEventProps {
  name: string;
  date: string; // ISO date string or Date object
  location?: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

const PostAttachmentEvent: React.FC<PostAttachmentEventProps> = ({ 
  name, 
  date, 
  location, 
  onPress, 
  style 
}) => {
  const theme = useTheme();

  // Parse date and format
  const eventDate = React.useMemo(() => {
    try {
      const d = typeof date === 'string' ? new Date(date) : date;
      if (isNaN(d.getTime())) return null;
      return d;
    } catch {
      return null;
    }
  }, [date]);

  const day = eventDate ? eventDate.getDate() : null;
  const month = eventDate ? eventDate.toLocaleString('default', { month: 'short' }) : null;
  const year = eventDate ? eventDate.getFullYear() : null;
  const time = eventDate ? eventDate.toLocaleTimeString('default', { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: true 
  }) : null;

  return (
    <TouchableOpacity
      style={[styles.container, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }, style]}
      activeOpacity={0.85}
      onPress={onPress}
      disabled={!onPress}
    >
      <View style={[styles.calendarSection, { backgroundColor: theme.colors.primary }]}>
        {day !== null && (
          <>
            <Text style={styles.dayNumber}>{day}</Text>
            {month && <Text style={styles.monthText}>{month}</Text>}
            {year && <Text style={styles.yearText}>{year}</Text>}
          </>
        )}
      </View>
      <View style={styles.contentSection}>
        <Text style={[styles.eventName, { color: theme.colors.text }]} numberOfLines={2}>
          {name}
        </Text>
        {time && (
          <Text style={[styles.timeText, { color: theme.colors.textSecondary }]}>
            {time}
          </Text>
        )}
        {location && (
          <Text style={[styles.locationText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
            📍 {location}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  container: {
    width: 200,
    minHeight: 140,
    borderWidth: 1,
    borderRadius: 14,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  calendarSection: {
    width: 60,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayNumber: {
    fontSize: 28,
    fontWeight: '700',
    color: '#FFFFFF',
    lineHeight: 32,
  },
  monthText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#FFFFFF',
    textTransform: 'uppercase',
    marginTop: 2,
  },
  yearText: {
    fontSize: 10,
    fontWeight: '500',
    color: '#FFFFFF',
    opacity: 0.9,
    marginTop: 2,
  },
  contentSection: {
    flex: 1,
    padding: 12,
    justifyContent: 'center',
  },
  eventName: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
    lineHeight: 20,
  },
  timeText: {
    fontSize: 12,
    marginBottom: 4,
  },
  locationText: {
    fontSize: 11,
    marginTop: 2,
  },
});

export default PostAttachmentEvent;

