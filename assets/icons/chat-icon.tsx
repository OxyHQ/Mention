import { colors } from '@/styles/colors'
import { CSSProperties } from 'react';
export const Chat = ({ color = colors.primaryColor, size = 26, style }: { color?: string; size?: number; style?: CSSProperties }) => {
  return (
    <svg className="svgIcon" viewBox="0 0 24 24" aria-hidden="true" style={{ ...style, width: size, height: size, fill: color }}>
      <g>
        <path d="M1.998 5.5c0-1.381 1.119-2.5 2.5-2.5h15c1.381 0 2.5 1.119 2.5 2.5v13c0 1.381-1.119 2.5-2.5 2.5h-15c-1.381 0-2.5-1.119-2.5-2.5v-13zm2.5-.5c-.276 0-.5.224-.5.5v2.764l8 3.638 8-3.636V5.5c0-.276-.224-.5-.5-.5h-15zm15.5 5.463l-8 3.636-8-3.638V18.5c0 .276.224.5.5.5h15c.276 0 .5-.224.5-.5v-8.037z"></path>
      </g>
    </svg>
  );
};
