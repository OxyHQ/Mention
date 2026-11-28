import { resolveBloomColors } from '@oxy.so/bloom/appearance';
import { useTheme } from '@oxy.so/bloom/theme';
import { LogoIcon } from '@/assets/logo';

export function MentionNavigationLogo() {
  const { mode, colors } = useTheme();
  const color =
    mode === 'dark' ? resolveBloomColors(colors, 'action', 'solid').background : colors.text;
  return <LogoIcon size={28} color={color} />;
}
