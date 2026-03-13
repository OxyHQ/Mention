import React from "react";
import { View, ScrollView, Image, TouchableOpacity, StyleSheet } from "react-native";
import Animated from "react-native-reanimated";
import { useTheme } from "@/hooks/useTheme";
import { CloseIcon } from "@/assets/icons/close-icon";
import { BackArrowIcon } from "@/assets/icons/back-arrow-icon";
import { ChevronRightIcon } from "@/assets/icons/chevron-right-icon";
import { VideoPreview } from "./VideoPreview";
import { ScaleAndFadeIn, ScaleAndFadeOut } from "@/lib/animations/ScaleAndFade";
import { ComposerMediaItem, MEDIA_CARD_WIDTH, MEDIA_CARD_HEIGHT } from "@/utils/composeUtils";
import { cn } from "@/lib/utils";

interface MediaPreviewProps {
    mediaItems: ComposerMediaItem[];
    getMediaUrl: (id: string) => string;
    onRemove: (id: string) => void;
    onMove?: (id: string, direction: "left" | "right") => void;
    paddingLeft?: number;
}

export const MediaPreview: React.FC<MediaPreviewProps> = ({
    mediaItems,
    getMediaUrl,
    onRemove,
    onMove,
    paddingLeft = 0,
}) => {
    const theme = useTheme();

    if (mediaItems.length === 0) return null;

    return (
        <View className="mt-3 w-full" style={{ overflow: "visible" }}>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingRight: 12, gap: 12, paddingLeft }}
            >
                {mediaItems.map((mediaItem, index) => {
                    const mediaUrl = getMediaUrl(mediaItem.id);
                    const canMoveLeft = index > 0;
                    const canMoveRight = index < mediaItems.length - 1;

                    return (
                        <Animated.View
                            key={mediaItem.id}
                            entering={ScaleAndFadeIn}
                            exiting={ScaleAndFadeOut}
                            style={[
                                styles.mediaItem,
                                {
                                    borderColor: theme.colors.border,
                                    backgroundColor: theme.colors.backgroundSecondary,
                                },
                            ]}
                        >
                            {mediaItem.type === "video" ? (
                                <VideoPreview src={mediaUrl} />
                            ) : (
                                <Image source={{ uri: mediaUrl }} className="w-full h-full" resizeMode="cover" />
                            )}

                            {onMove && mediaItems.length > 1 && (
                                <View className="absolute left-2 right-2 bottom-2 flex-row justify-between items-center z-[2]" style={{ pointerEvents: 'box-none' }}>
                                    <TouchableOpacity
                                        onPress={() => onMove(mediaItem.id, "left")}
                                        disabled={!canMoveLeft}
                                        className={cn(
                                            "rounded-full p-1.5 bg-background",
                                            !canMoveLeft && "opacity-40"
                                        )}
                                    >
                                        <BackArrowIcon
                                            size={14}
                                            color={!canMoveLeft ? theme.colors.textTertiary : theme.colors.textSecondary}
                                        />
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        onPress={() => onMove(mediaItem.id, "right")}
                                        disabled={!canMoveRight}
                                        className={cn(
                                            "rounded-full p-1.5 bg-background",
                                            !canMoveRight && "opacity-40"
                                        )}
                                    >
                                        <ChevronRightIcon
                                            size={14}
                                            color={
                                                !canMoveRight ? theme.colors.textTertiary : theme.colors.textSecondary
                                            }
                                        />
                                    </TouchableOpacity>
                                </View>
                            )}

                            <TouchableOpacity
                                onPress={() => onRemove(mediaItem.id)}
                                className="absolute top-2 right-2 rounded-full p-1.5 bg-background"
                                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                            >
                                <CloseIcon size={16} className="text-foreground" />
                            </TouchableOpacity>
                        </Animated.View>
                    );
                })}
            </ScrollView>
        </View>
    );
};

const styles = StyleSheet.create({
    mediaItem: {
        width: MEDIA_CARD_WIDTH,
        height: MEDIA_CARD_HEIGHT,
        borderRadius: 15,
        borderWidth: 1,
        overflow: "hidden",
        position: "relative",
    },
});
