import { type ViewStyle } from 'react-native';

export interface ProfileHoverCardProps {
  children: React.ReactNode;
  /**
   * Normalized handle of the profile the card previews (`user` or
   * `user@domain`) — the same value that builds the `/@handle` route.
   *
   * Optional because it is legitimately ABSENT for a degraded author (Mention's
   * ghost-handle rule: an unresolved actor renders an empty handle and no
   * profile link). The card is then inert — it never opens a preview that could
   * not resolve — so call sites can pass the handle straight through instead of
   * guarding each one.
   */
  username?: string;
  disable?: boolean;
  style?: ViewStyle;
}
