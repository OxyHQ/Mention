import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type LabelActionType = 'show' | 'warn' | 'blur' | 'hide';

export interface LabelBadgeProps {
  labelName: string;
  labelerName: string;
  severity: Severity;
  action: LabelActionType;
  onShowAnyway?: () => void;
}

export const SEVERITY_COLORS: Record<Severity, string> = {
  low: '#6b7280',
  medium: '#f59e0b',
  high: '#f97316',
  critical: '#ef4444',
};

const LabelBadge: React.FC<LabelBadgeProps> = ({
  labelName,
  labelerName,
  severity,
  action,
  onShowAnyway,
}) => {
  const color = SEVERITY_COLORS[severity] ?? SEVERITY_COLORS.low;

  if (action === 'hide' || action === 'blur') {
    return null;
  }

  if (action === 'warn') {
    return (
      <View
        style={[
          styles.warnBar,
          { backgroundColor: `${color}12`, borderColor: `${color}40` },
        ]}
      >
        <View style={styles.warnContent}>
          <Text className="text-foreground" style={styles.warnText}>
            This post was labeled{' '}
            <Text style={[styles.warnLabel, { color }]}>{labelName}</Text>
            {' '}by{' '}
            <Text style={styles.warnLabeler}>{labelerName}</Text>
          </Text>
        </View>
        {onShowAnyway && (
          <TouchableOpacity
            style={[styles.showAnywayBtn, { borderColor: color }]}
            onPress={onShowAnyway}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={[styles.showAnywayText, { color }]}>Show anyway</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  // action === 'show'
  return (
    <View
      style={[
        styles.showBadge,
        { backgroundColor: `${color}15`, borderColor: `${color}40` },
      ]}
    >
      <Text style={[styles.showBadgeText, { color }]} numberOfLines={1}>
        {labelName}
      </Text>
    </View>
  );
};

export default React.memo(LabelBadge);

const styles = StyleSheet.create({
  // 'show' badge — small inline tag
  showBadge: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  showBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  // 'warn' interstitial bar — full width
  warnBar: {
    width: '100%',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  warnContent: {
    flex: 1,
  },
  warnText: {
    fontSize: 13,
    lineHeight: 18,
  },
  warnLabel: {
    fontWeight: '700',
  },
  warnLabeler: {
    fontWeight: '600',
  },
  showAnywayBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  showAnywayText: {
    fontSize: 12,
    fontWeight: '600',
  },
});
