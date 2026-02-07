import React from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import SpaceCard from '@/components/SpaceCard';

interface PostAttachmentSpaceProps {
  spaceId: string;
  title: string;
  status?: 'scheduled' | 'live' | 'ended';
  topic?: string;
  host?: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

const PostAttachmentSpace: React.FC<PostAttachmentSpaceProps> = ({
  spaceId,
  title,
  status,
  topic,
  host,
  onPress,
  style,
}) => {
  return (
    <SpaceCard
      space={{
        _id: spaceId,
        title,
        status: status || 'scheduled',
        topic,
        participants: [],
        host: host || '',
      }}
      variant="compact"
      onPress={onPress}
      style={style}
    />
  );
};

export default PostAttachmentSpace;
