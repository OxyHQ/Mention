import { type ViewStyle } from 'react-native';

export interface ProfileHoverCardProps {
  children: React.ReactNode;
  username: string;
  disable?: boolean;
  inline?: boolean;
  style?: ViewStyle;
}
