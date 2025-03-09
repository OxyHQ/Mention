import { OxyProfile } from '../../types';

export type AuthMode = 'signin' | 'signup' | 'session';

export interface AuthBottomSheetProps {
    /** Initial auth mode to display */
    initialMode?: AuthMode;
    /** Whether to show the logo in the header (default: true) */
    showLogo?: boolean;
    /** Callback when authentication is successful */
    onSuccess?: () => void;
}

export interface UserSession {
    id: string;
    username: string;
    name?: {
        first?: string;
        last?: string;
    };
    avatar?: string;
}

export interface Session {
    id: string;
    profile: OxyProfile;
    lastActive: Date;
}