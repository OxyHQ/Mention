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
            const playVideo = async () => {
                try {
                    await player.play();
                } catch {
                    // Autoplay may be blocked on web
                }
            };
            playVideo();
        }
        return () => {
            if (player) {
                try {
                    player.pause();
                } catch {
                    // Silently handle pause errors
                }
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
