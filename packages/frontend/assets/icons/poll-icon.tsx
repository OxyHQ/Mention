import React from 'react';
import Svg, { Path, Rect } from 'react-native-svg';
interface PollIconProps {
    size?: number;
    color?: string;
    className?: string;
}

export const PollIcon: React.FC<PollIconProps> = ({
    size = 20,
    color = 'currentColor',
    className
}) => {
    return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
            <Rect fill={color} height="1.5" rx="0.75" width="8" x="4" y="5.5" />
            <Rect fill={color} height="1.5" rx="0.75" width="16" x="4" y="11.25" />
            <Rect fill={color} height="1.5" rx="0.75" width="11" x="4" y="17" />
        </Svg>
    );
};

export default PollIcon; 