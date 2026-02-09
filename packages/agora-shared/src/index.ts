// Types
export type {
  Space,
  SpaceParticipant,
  ParticipantsUpdateData,
  MuteUpdateData,
  SpeakerRequestData,
  StreamInfo,
  SpaceAttachmentData,
  UserEntity,
  SpacesTheme,
  HttpResponse,
  HttpRequestConfig,
  HttpClient,
  FileDownloadService,
} from './types';

// Validation
export {
  ZSpace,
  ZSpaceParticipant,
  ZStartStreamResponse,
  ZGenerateStreamKeyResponse,
  ZStreamInfo,
  validateSpace,
  validateSpaces,
} from './validation';

// Context
export {
  AgoraProvider,
  useAgoraConfig,
  type AgoraConfig,
  type AgoraConfigInternal,
} from './context/SpacesConfigContext';
export { LiveSpaceProvider, useLiveSpace } from './context/LiveSpaceContext';

// Services
export {
  createAgoraService,
  type AgoraServiceInstance,
} from './services/spacesService';
export { SpaceSocketService } from './services/spaceSocketService';
export {
  createGetSpaceToken,
  type GetSpaceTokenFn,
} from './services/livekitService';

// Hooks
export { useSpaceConnection } from './hooks/useSpaceConnection';
export { useSpaceAudio } from './hooks/useSpaceAudio';
export { useSpaceUsers, getDisplayName, getAvatarUrl } from './hooks/useSpaceUsers';
export { useSpaceManager } from './hooks/useSpaceManager';

// Components
export { SpaceCard } from './components/SpaceCard';
export { LiveSpaceSheet } from './components/LiveSpaceSheet';
export { MiniSpaceBar, MINI_BAR_HEIGHT } from './components/MiniSpaceBar';
export { StreamConfigModal } from './components/StreamConfigModal';
export { StreamConfigPanel } from './components/StreamConfigPanel';
export { InsightsPanel } from './components/InsightsPanel';
export { CreateSpaceSheet, type CreateSpaceSheetRef, type CreateSpaceFormState } from './components/CreateSpaceSheet';

// Assets
export { Agora, AgoraActive } from './assets/icons/spaces-icon';
