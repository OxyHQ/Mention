import { colors } from '@/styles/colors';
import { convertShadowToBoxShadow } from './theme';

export const shadowStyle = (opts?: { elevation?: number; web?: string }) => {
  const elev = opts?.elevation ?? 2;
  const offsetY = Math.max(1, Math.round(elev / 2));
  const radius = Math.max(1, elev * 2);
  const web = opts?.web ?? convertShadowToBoxShadow(colors.shadow, { width: 0, height: offsetY }, 0.2, radius);
  return {
    boxShadow: web,
    elevation: elev,
  };
};
