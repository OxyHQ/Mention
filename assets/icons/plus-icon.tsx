import { colors } from '@/styles/colors'
import { CSSProperties } from 'react';
export const Plus = ({ color = colors.primaryColor, size = 26, style }: { color?: string; size?: number; style?: CSSProperties }) => {
  return (
    <svg className="svgIcon" viewBox="0 0 24 24" aria-hidden="true" style={{ ...style, width: size, height: size, fill: color }}>
      <g>
        <path d="M11 11V4h2v7h7v2h-7v7h-2v-7H4v-2h7z"></path>
      </g>
    </svg>
  );
};
