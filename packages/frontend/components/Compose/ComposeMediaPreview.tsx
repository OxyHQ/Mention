import React from 'react';
import { Image, type ImageStyle, type StyleProp } from 'react-native';
import { VideoPreview } from '@/components/Compose/VideoPreview';
import type { ComposerMediaType } from '@/utils/composeUtils';

interface ComposeMediaPreviewProps {
  type: ComposerMediaType;
  uri: string;
  imageStyle: StyleProp<ImageStyle>;
}

/**
 * The thumbnail of one attachment in the composer.
 *
 * A GIF is stored as a looping muted mp4 (`/gifs/use` returns the mp4's file
 * id), so it plays as a video exactly like it does in the feed — an `Image`
 * cannot decode an mp4 and rendered an empty box.
 */
export const ComposeMediaPreview: React.FC<ComposeMediaPreviewProps> = ({ type, uri, imageStyle }) =>
  type === 'image' ? (
    <Image source={{ uri }} style={imageStyle} resizeMode="cover" />
  ) : (
    <VideoPreview src={uri} />
  );
