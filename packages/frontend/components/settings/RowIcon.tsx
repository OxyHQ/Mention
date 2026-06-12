import React from 'react';
import { useTheme } from '@oxyhq/bloom/theme';
import { Icon, type IconName } from '@/lib/icons';

interface RowIconProps {
  name: IconName;
  destructive?: boolean;
}

export const RowIcon: React.FC<RowIconProps> = ({ name, destructive }) => {
  const { colors } = useTheme();
  return (
    <Icon
      name={name}
      size={20}
      color={destructive ? colors.error : colors.textSecondary}
    />
  );
};
