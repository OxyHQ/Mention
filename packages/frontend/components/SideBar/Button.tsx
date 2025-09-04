import React, { FC } from 'react';
import { ViewStyle } from 'react-native';
import { Pressable } from 'react-native-web-hover';
import { useMediaQuery } from 'react-responsive';
import { Link } from 'expo-router'; // added Link import

type ChildProps = {
    href?: string; // optional href prop
    renderText: ({ state }: { state: 'desktop' | 'tablet' }) => React.ReactNode;
    renderIcon: ({ state }: { state: 'desktop' | 'tablet' }) => React.ReactNode;
    containerStyle: ({ state }: { state: 'desktop' | 'tablet' }) => ViewStyle;
};

export const Button: FC<ChildProps> = ({ href, renderText, renderIcon, containerStyle }) => {
    const isDesktop = useMediaQuery({ minWidth: 1266 });
    const state = isDesktop ? 'desktop' : 'tablet';
    const style = containerStyle?.({ state });

    if (href) {
        return (
            <Link href={href} style={style}>
                {renderIcon ? renderIcon({ state }) : null}
                {renderText ? renderText({ state }) : null}
            </Link>
        );
    }

    return (
        <Pressable style={style}>
            {renderIcon ? renderIcon({ state }) : null}
            {renderText ? renderText({ state }) : null}
        </Pressable>
    );
};
