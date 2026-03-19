import React from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';

interface IconProps {
    size?: number;
    color?: string;
    className?: string;
    style?: StyleProp<ViewStyle>;
}

export const AutomatedIcon = ({ size = 24, color = 'currentColor', className, style }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} style={style}>
        <Path
            d="M11.9997 14C12.5519 14 12.9997 14.4477 12.9997 15C12.9997 15.5523 12.5519 16 11.9997 16C7.99569 16.0001 4.5971 18.6603 3.45377 22.2998C3.28818 22.8266 2.7267 23.1196 2.19986 22.9541C1.67323 22.7884 1.38014 22.2269 1.54556 21.7002C2.94019 17.2609 7.08729 14.0001 11.9997 14Z"
            fill={color}
        />
        <Path
            d="M17.9997 14.5C20.2088 14.5 21.9997 16.2909 21.9997 18.5C21.9997 20.7091 20.2088 22.5 17.9997 22.5C15.7907 22.4998 13.9997 20.709 13.9997 18.5C13.9997 16.291 15.7907 14.5002 17.9997 14.5Z"
            fill={color}
        />
        <Path
            d="M11.9997 1C15.0373 1 17.4997 3.46244 17.4997 6.5C17.4997 9.53756 15.0373 12 11.9997 12C8.9622 11.9998 6.49966 9.53745 6.49966 6.5C6.49966 3.46255 8.96223 1.00018 11.9997 1ZM11.9997 3C10.0668 3.00018 8.49966 4.56711 8.49966 6.5C8.49966 8.43289 10.0668 9.99982 11.9997 10C13.9327 10 15.4997 8.433 15.4997 6.5C15.4997 4.567 13.9327 3 11.9997 3Z"
            fill={color}
            fillRule="evenodd"
            clipRule="evenodd"
        />
    </Svg>
);
