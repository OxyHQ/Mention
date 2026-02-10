import React from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import RoomCard from '@/components/SpaceCard';

interface PostAttachmentRoomProps {
  roomId: string;
  title: string;
  status?: 'scheduled' | 'live' | 'ended';
  topic?: string;
  host?: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

const PostAttachmentRoom: React.FC<PostAttachmentRoomProps> = ({
  roomId,
  title,
  status,
  topic,
  host,
  onPress,
  style,
}) => {
  return (
    <RoomCard
      room={{
        _id: roomId,
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

export default PostAttachmentRoom;
