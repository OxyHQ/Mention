import React, { createContext, useReducer, useEffect, ReactNode, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { login, logout, loadSession, selectSession, updateLastRefresh } from '@/store/reducers/sessionReducer';
import { setProfile, clearProfile } from '@/store/reducers/profileReducer';
import { validateSession, refreshAccessToken } from '@/utils/api';
import { getData, storeData } from '@/utils/storage';
import { Profile } from '@/interfaces/Profile';

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
    registerUser: (user: User) => Promise<void>;
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
    
    const [sessions, setSessions] = useState<User[]>([]);
    const reduxDispatch = useDispatch();
    useSelector(selectSession);

    // Load available sessions
    useEffect(() => {
        const loadSessions = async () => {
            try {
                const storedSessions = await getData<User[]>('availableSessions') || [];
                setSessions(storedSessions);
            } catch (error) {
                console.error('Error loading sessions:', error);
            }
        };
        loadSessions();
    }, []);

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
                            const storedProfile = await getData<Profile>('profile');
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
                                            
                                            const storedProfile = await getData<Profile>('profile');
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
            
            // Update sessions list
            const updatedSessions = [...sessions];
            if (!sessions.find(s => s.id === user.id)) {
                updatedSessions.push(user);
                setSessions(updatedSessions);
                await storeData('availableSessions', updatedSessions);
            }
            
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

    const registerUser = async (user: User) => {
        try {
            await loginUser(user);
        } catch (error) {
            console.error('Registration error:', error);
            throw error;
        }
    };

    const switchSession = async (sessionId: string) => {
        const targetSession = sessions.find(s => s.id === sessionId);
        if (targetSession) {
            await logoutUser(); // Clear current session and profile
            await loginUser(targetSession);
        }
    };

    useEffect(() => {
        const interval = setInterval(async () => {
            try {
                const isValid = await validateSession();
                if (!isValid) {
                    await refreshAccessToken();
                }
                reduxDispatch(updateLastRefresh());
            } catch (error) {
                console.error('Token refresh error:', error);
                await logoutUser();
            }
        }, 15 * 60 * 1000); // 15 minutes

        return () => clearInterval(interval);
    }, [reduxDispatch]);

    if (state.isLoading) {
        return null;
    }

    return (
        <SessionContext.Provider value={{
            state,
            loginUser,
            logoutUser,
            getCurrentUser,
            sessions,
            switchSession,
            registerUser
        }}>
            {children}
        </SessionContext.Provider>
    );
};

export { SessionProvider, SessionContext };
