import type { ComponentType, ReactNode } from 'react';
import type { Room } from '@/lib/syraApi';

export interface CreateRoomFormState {
  isValid: boolean;
  loading: boolean;
  hasScheduledStart: boolean;
}

export interface CreateRoomSheetProps {
  onClose: () => void;
  onRoomCreated?: (room: Room) => void;
  mode?: 'standalone' | 'embed';
  ScrollViewComponent?: ComponentType<{ children: ReactNode }>;
  hideFooter?: boolean;
  onFormStateChange?: (state: CreateRoomFormState) => void;
}
