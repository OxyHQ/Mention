import React, { createContext, useReducer, useEffect, ReactNode } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { login, logout, loadSession, selectSession } from '@/store/reducers/sessionReducer';
import { setProfile, clearProfile } from '@/store/reducers/profileReducer';
import { validateSession, refreshAccessToken } from '@/utils/api';
import { getData, storeData } from '@/utils/storage';
import { OXY_CLOUD_URL } from '@/config';

interface User {
    id: string;
    username: string;
    name?: {
        first?: string;
        last?: string;
    };
    avatar?: string;
    [key: string]: any;
}

interface SessionState {
    isAuthenticated: boolean;
    user: User | null;
    isLoading: boolean;
    lastRefresh?: number;
}

interface SessionContextType {
    state: SessionState;
    loginUser: (user: User) => Promise<void>;
    logoutUser: () => Promise<void>;
    getCurrentUser: () => User | null;
    sessions: User[];
    switchSession: (sessionId: string) => Promise<void>;
}

const SessionContext = createContext<SessionContextType | null>(null);

type Action =
    | { type: 'LOGIN'; payload: User }
    | { type: 'LOGOUT' }
    | { type: 'SET_LOADING'; payload: boolean };

const sessionReducer = (state: SessionState, action: Action): SessionState => {
    switch (action.type) {
        case 'LOGIN':
            return { ...state, isAuthenticated: true, user: action.payload, isLoading: false };
        case 'LOGOUT':
            return { ...state, isAuthenticated: false, user: null, isLoading: false };
        case 'SET_LOADING':
            return { ...state, isLoading: action.payload };
        default:
            return state;
    }
};

interface SessionProviderProps {
    children: ReactNode;
}

const SessionProvider = ({ children }: SessionProviderProps) => {
    const [state, dispatch] = useReducer(sessionReducer, {
        isAuthenticated: false,
        user: null,
        isLoading: true
    });
    
    const reduxDispatch = useDispatch();
    useSelector(selectSession);

    useEffect(() => {
        const initializeSession = async () => {
            try {
                dispatch({ type: 'SET_LOADING', payload: true });
                
                // Try to restore session from storage first
                const storedSession = await getData<SessionState>('session');
                if (storedSession && storedSession.isAuthenticated && storedSession.user) {
                    // First check if we have valid tokens
                    const [accessToken, refreshToken] = await Promise.all([
                        getData<string>('accessToken'),
                        getData<string>('refreshToken')
                    ]);

                    if (!accessToken && !refreshToken) {
                        console.log('No tokens found, logging out');
                        await logoutUser();
                        return;
                    }

                    // Try to validate the current session
                    try {
                        const isValid = await validateSession();
                        if (isValid) {
                            dispatch({ type: 'LOGIN', payload: storedSession.user });
                            reduxDispatch(loadSession({
                                isAuthenticated: true,
                                user: storedSession.user,
                                lastRefresh: storedSession.lastRefresh
                            }));
                            
                            // Load profile data if available
                            const storedProfile = await getData('profile');
                            if (storedProfile) {
                                reduxDispatch(setProfile(storedProfile));
                            }
                            return;
                        }
                    } catch (error: any) {
                        // Check specifically for session expiration
                        if (error?.message?.includes('expired') || error?.response?.status === 401) {
                            console.log('Session expired, attempting token refresh');
                            if (refreshToken) {
                                try {
                                    const tokens = await refreshAccessToken();
                                    if (tokens) {
                                        // Re-validate session after token refresh
                                        const isValid = await validateSession();
                                        if (isValid) {
                                            dispatch({ type: 'LOGIN', payload: storedSession.user });
                                            reduxDispatch(loadSession({
                                                isAuthenticated: true,
                                                user: storedSession.user,
                                                lastRefresh: Date.now()
                                            }));
                                            
                                            const storedProfile = await getData('profile');
                                            if (storedProfile) {
                                                reduxDispatch(setProfile(storedProfile));
                                            }
                                            return;
                                        }
                                    }
                                } catch (refreshError) {
                                    console.error('Token refresh failed:', refreshError);
                                    await logoutUser();
                                    return;
                                }
                            }
                        }
                        console.error('Session validation failed:', error);
                    }
                }

                // If we get here, no valid session was restored
                await logoutUser();
            } catch (error) {
                console.error('Session initialization error:', error);
                await logoutUser();
            } finally {
                dispatch({ type: 'SET_LOADING', payload: false });
            }
        };

        initializeSession();
    }, [reduxDispatch]);

    const loginUser = async (user: User) => {
        try {
            dispatch({ type: 'LOGIN', payload: user });
            reduxDispatch(login(user));
            // Store complete session state
            const sessionData = { isAuthenticated: true, user };
            await storeData('session', sessionData);
        } catch (error) {
            console.error('Login error:', error);
            throw error;
        }
    };

    const logoutUser = async () => {
        try {
            dispatch({ type: 'LOGOUT' });
            reduxDispatch(logout());
            reduxDispatch(clearProfile());
            await Promise.all([
                storeData('user', null),
                storeData('accessToken', null),
                storeData('refreshToken', null),
                storeData('session', null),
                storeData('profile', null)
            ]);
        } catch (error) {
            console.error('Logout error:', error);
            throw error;
        }
    };

    const getCurrentUser = () => state.user;

    // Temp sessions for development
    const fakeSessions = [
        {
            id: '679f4993e38393a3a9edd4dd',
            username: 'nate',
            name: { first: 'Nate', last: 'Isern' },
            avatarSource: { uri: `${OXY_CLOUD_URL}/files/6790749544634262da8394f2` },
        },
        {
            id: '679fcac00e2353edc2f02f19',
            username: 'mention',
            name: { first: 'Mention' },
            avatarSource: { uri: 'http://localhost:8081/assets/?unstable_path=.%2Fassets%2Fimages/default-avatar.jpg' },
        }
    ];

    const switchSession = async (sessionId: string) => {
        const foundSession = fakeSessions.find(s => s.id === sessionId);
        if (foundSession) {
            await logoutUser(); // Clear current session and profile
            await loginUser(foundSession);
        }
    };

    if (state.isLoading) {
        return null;
    }

    return (
        <SessionContext.Provider value={{
            state,
            loginUser,
            logoutUser,
            getCurrentUser,
            sessions: fakeSessions,
            switchSession
        }}>
            {children}
        </SessionContext.Provider>
    );
};

export { SessionProvider, SessionContext };
