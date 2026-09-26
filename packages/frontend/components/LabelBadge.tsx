import React from 'react';
import { Text } from 'react-native';
import {
  AdmonitionButton,
  AdmonitionContent,
  AdmonitionIcon,
  AdmonitionRoot,
  AdmonitionRow,
  AdmonitionText,
} from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import type { AccentTone } from '@oxy.so/bloom/theme';

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type LabelActionType = 'show' | 'warn' | 'blur' | 'hide';

export interface LabelBadgeProps {
  labelName: string;
  labelerName: string;
  severity: Severity;
  action: LabelActionType;
  onShowAnyway?: () => void;
}

/**
 * Raw severity swatches. Still read by the labeler detail screen
 * (`app/(app)/moderation/labelers/[id].tsx`); this component itself paints from
 * Bloom's semantic tones below, so a badge follows the theme and mode.
 */
export const SEVERITY_COLORS: Record<Severity, string> = {
  low: '#6b7280',
  medium: '#f59e0b',
  high: '#f97316',
  critical: '#ef4444',
};

/**
 * Severity as Bloom paints it. Bloom has no orange role, so `high` and
 * `critical` share the error tone and differ in loudness: `critical` is the
 * solid fill, everything else the legible subtle tint.
 */
export const SEVERITY_TONES: Record<Severity, { tone: AccentTone; variant: 'subtle' | 'solid' }> = {
  low: { tone: 'default', variant: 'subtle' },
  medium: { tone: 'warning', variant: 'subtle' },
  high: { tone: 'error', variant: 'subtle' },
  critical: { tone: 'error', variant: 'solid' },
};

/** Which callout a `warn` label raises: a note, a caution, or a hard stop. */
const SEVERITY_ADMONITION: Record<Severity, 'info' | 'warning' | 'error'> = {
  low: 'info',
  medium: 'warning',
  high: 'warning',
  critical: 'error',
};

// Spans inside the callout's sentence: plain nested `Text`, so they inherit its
// size and colour and add nothing but the weight.
const BOLD = { fontWeight: '700' as const };
const SEMIBOLD = { fontWeight: '600' as const };
const SHOW_ANYWAY = { alignSelf: 'flex-start' as const };

const LabelBadge: React.FC<LabelBadgeProps> = ({
  labelName,
  labelerName,
  severity,
  action,
  onShowAnyway,
}) => {
  if (action === 'hide' || action === 'blur') {
    return null;
  }

  if (action === 'warn') {
    return (
      <AdmonitionRoot type={SEVERITY_ADMONITION[severity] ?? 'info'}>
        <AdmonitionRow>
          <AdmonitionIcon />
          <AdmonitionContent>
            <AdmonitionText>
              This post was labeled{' '}
              <Text style={BOLD}>{labelName}</Text>
              {' '}by{' '}
              <Text style={SEMIBOLD}>{labelerName}</Text>
            </AdmonitionText>
            {onShowAnyway ? (
              <AdmonitionButton
                appearance="outline"
                tone="neutral"
                onPress={onShowAnyway}
                style={SHOW_ANYWAY}
              >
                Show anyway
              </AdmonitionButton>
            ) : null}
          </AdmonitionContent>
        </AdmonitionRow>
      </AdmonitionRoot>
    );
  }

  // action === 'show'
  const paint = SEVERITY_TONES[severity] ?? SEVERITY_TONES.low;
  return (
    <Badge
      content={labelName}
      color={paint.tone}
      variant={paint.variant}
      size="label-small"
    />
  );
};

export default React.memo(LabelBadge);
