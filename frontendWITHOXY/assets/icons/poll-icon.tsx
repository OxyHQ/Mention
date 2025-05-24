import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { colors } from '@/styles/colors';

interface PollIconProps {
    size?: number;
    color?: string;
}

export const PollIcon: React.FC<PollIconProps> = ({
    size = 20,
    color = colors.primaryColor
}) => {
    return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
            <Path
                d="M3 4h18v2H3V4zm0 7h12v2H3v-2zm0 7h18v2H3v-2z"
                fill={color}
            />
            <Path
                d="M17 10h4v4h-4v-4z"
                fill={color}
            />
        </Svg>
    );
};

export default PollIcon; 