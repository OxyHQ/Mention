import type { ViewModifier } from '@oxy.so/bloom-language';
import RoomCard from '@/components/RoomCard';

interface PostAttachmentRoomProps {
  roomId: string;
  title: string;
  status?: 'scheduled' | 'live' | 'ended';
  topic?: string;
  host?: string;
  onPress?: () => void;
  /** The cell's frame and padding from the row, in place of the compact card's own padding. */
  look?: ViewModifier;
}

/** A post's room attachment: the compact room card. */
function PostAttachmentRoom({
  roomId,
  title,
  status,
  topic,
  host,
  onPress,
  look,
}: PostAttachmentRoomProps) {
  return RoomCard({
    room: {
      _id: roomId,
      title,
      status: status || 'scheduled',
      topic,
      participants: [],
      host: host || '',
    },
    variant: 'compact',
    onPress,
    look,
  });
}

export default PostAttachmentRoom;
