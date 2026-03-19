import React from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import Svg, { Path, Line } from 'react-native-svg';

interface IconProps {
    size?: number;
    color?: string;
    className?: string;
    style?: StyleProp<ViewStyle>;
}

export const AgentIcon = ({ size = 28, color = 'currentColor', className, style }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 28 28" fill="none" className={className} style={style}>
        <Path
            d="M10.997 2.79a5.38 5.38 0 0 1 3.264.15.75.75 0 0 1-.521 1.407A3.902 3.902 0 0 0 8.5 7.789a.75.75 0 0 1-.707.707 3.9 3.9 0 0 0-3.455 2.578l-.095.307a3.9 3.9 0 0 0 1.631 4.274c.32.21.431.624.259.965a3.902 3.902 0 0 0 5.24 5.24.75.75 0 0 1 .967.26 3.9 3.9 0 0 0 4.273 1.632 3.9 3.9 0 0 0 2.884-3.552l.02-.138a.75.75 0 0 1 .688-.568 3.9 3.9 0 0 0 3.443-5.238.75.75 0 1 1 1.407-.52 5.398 5.398 0 0 1-4.133 7.18A5.4 5.4 0 0 1 17 25.201v.001a5.4 5.4 0 0 1-5.535-1.748 5.4 5.4 0 0 1-6.925-6.924A5.402 5.402 0 0 1 7.076 7.07a5.4 5.4 0 0 1 3.92-4.278zm6.76 13.148a.75.75 0 0 1 1.06 1.06c-1.059 1.06-2.184 1.777-3.445 2.115s-2.594.279-4.04-.108a.75.75 0 0 1 .388-1.45c1.258.338 2.316.363 3.264.109s1.851-.805 2.773-1.726"
            fill={color}
        />
        <Line
            x1="21" y1="3.5" x2="21" y2="10.5"
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
        />
        <Line
            x1="17.5" y1="7" x2="24.5" y2="7"
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
        />
    </Svg>
);
