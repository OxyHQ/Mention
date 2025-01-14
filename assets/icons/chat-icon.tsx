import { colors } from '@/styles/colors'
import { CSSProperties } from 'react';
export const Chat = ({ color = colors.primaryColor, size = 26, style }: { color?: string; size?: number; style?: CSSProperties }) => {
  return (
    <svg className="svgIcon" viewBox="0 0 24 24" aria-hidden="true" style={{ ...style, width: size, height: size, fill: color, transform: 'translateY(2px)' }}>
      <line fill="none" stroke={color} stroke-linejoin="round" stroke-width="2" x1="22" x2="9.218" y1="3" y2="10.083"></line>
      <polygon fill="none" points="11.698 20.334 22 3.001 2 3.001 9.218 10.084 11.698 20.334" stroke={color} stroke-linejoin="round" stroke-width="2"></polygon>
    </svg>
  );
};

export const ChatActive = ({ color = colors.primaryColor, size = 26, style }: { color?: string; size?: number; style?: CSSProperties }) => {
  return (
    <svg className="svgIcon" viewBox="0 0 24 24" aria-hidden="true" style={{ ...style, width: size, height: size, fill: color, transform: 'translateY(2px)' }}>
      <path fill={color} d="M22.91 2.388a.69.69 0 0 0-.597-.347l-20.625.002a.687.687 0 0 0-.482 1.178L7.26 9.16a.686.686 0 0 0 .778.128l7.612-3.657a.723.723 0 0 1 .937.248.688.688 0 0 1-.225.932l-7.144 4.52a.69.69 0 0 0-.3.743l2.102 8.692a.687.687 0 0 0 .566.518.655.655 0 0 0 .103.008.686.686 0 0 0 .5-.337L22.903 3.08a.688.688 0 0 0 .007-.692" fill-rule="evenodd"></path>
    </svg>
  );
};
