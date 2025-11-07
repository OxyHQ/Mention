import React from "react";
import { View, ScrollView, Image, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import { CloseIcon } from "@/assets/icons/close-icon";
import { BackArrowIcon } from "@/assets/icons/back-arrow-icon";
import { ChevronRightIcon } from "@/assets/icons/chevron-right-icon";
import { VideoPreview } from "./VideoPreview";
import { ComposerMediaItem, MEDIA_CARD_WIDTH, MEDIA_CARD_HEIGHT } from "@/utils/composeUtils";

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
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingLeft }]}
      >
        {mediaItems.map((mediaItem, index) => {
          const mediaUrl = getMediaUrl(mediaItem.id);
          const canMoveLeft = index > 0;
          const canMoveRight = index < mediaItems.length - 1;

          return (
            <View
              key={mediaItem.id}
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
                <Image source={{ uri: mediaUrl }} style={styles.image} resizeMode="cover" />
              )}

              {onMove && mediaItems.length > 1 && (
                <View style={styles.reorderControls} pointerEvents="box-none">
                  <TouchableOpacity
                    onPress={() => onMove(mediaItem.id, "left")}
                    disabled={!canMoveLeft}
                    style={[
                      styles.reorderButton,
                      { backgroundColor: theme.colors.background },
                      !canMoveLeft && styles.reorderButtonDisabled,
                    ]}
                  >
                    <BackArrowIcon
                      size={14}
                      color={!canMoveLeft ? theme.colors.textTertiary : theme.colors.textSecondary}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => onMove(mediaItem.id, "right")}
                    disabled={!canMoveRight}
                    style={[
                      styles.reorderButton,
                      { backgroundColor: theme.colors.background },
                      !canMoveRight && styles.reorderButtonDisabled,
                    ]}
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
                style={[styles.removeButton, { backgroundColor: theme.colors.background }]}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              >
                <CloseIcon size={16} color={theme.colors.text} />
              </TouchableOpacity>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginTop: 12,
    width: "100%",
    overflow: "visible",
  },
  scroll: {
    paddingRight: 12,
    gap: 12,
  },
  mediaItem: {
    width: MEDIA_CARD_WIDTH,
    height: MEDIA_CARD_HEIGHT,
    borderRadius: 15,
    borderWidth: 1,
    overflow: "hidden",
    position: "relative",
  },
  image: {
    width: "100%",
    height: "100%",
  },
  removeButton: {
    position: "absolute",
    top: 8,
    right: 8,
    borderRadius: 999,
    padding: 6,
  },
  reorderControls: {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    zIndex: 2,
  },
  reorderButton: {
    borderRadius: 999,
    padding: 6,
  },
  reorderButtonDisabled: {
    opacity: 0.4,
  },
});
