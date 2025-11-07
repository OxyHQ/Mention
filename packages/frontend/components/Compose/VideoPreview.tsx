import React from "react";
import { VideoView, useVideoPlayer } from "expo-video";

interface VideoPreviewProps {
    src: string;
    style?: any;
}

export const VideoPreview: React.FC<VideoPreviewProps> = ({ src, style }) => {
    const player = useVideoPlayer(src, (player) => {
        if (player) {
            player.loop = true;
            player.muted = true;
        }
    });

    React.useEffect(() => {
        if (player) {
            player.play();
        }
        return () => {
            if (player) {
                player.pause();
            }
        };
    }, [player]);

    return (
        <VideoView
            player={player}
            style={style || { width: "100%", height: "100%" }}
            contentFit="cover"
            nativeControls={false}
            allowsFullscreen={false}
        />
    );
};
