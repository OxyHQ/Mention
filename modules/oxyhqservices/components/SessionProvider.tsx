import React, { createContext, useReducer, useEffect } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { login, logout, loadSession, selectSession } from '@/store/reducers/sessionReducer';
import { validateSession } from '@/utils/api';
import { getData } from '@/utils/storage';

interface SessionContextType {
    state: {
        isAuthenticated: boolean;
        user: any;
    };
    loginUser: (user: any) => void;
    logoutUser: () => void;
    getCurrentUser: () => any;
    sessions: any[]; // added sessions array
    switchSession: (sessionId: string) => void;
}

const SessionContext = createContext<SessionContextType | null>(null);

const sessionReducer = (state, action) => {
    switch (action.type) {
        case 'LOGIN':
            return { ...state, isAuthenticated: true, user: action.payload };
        case 'LOGOUT':
            return { ...state, isAuthenticated: false, user: null };
        default:
            return state;
    }
};

const SessionProvider = ({ children }) => {
    const [state, dispatch] = useReducer(sessionReducer, { isAuthenticated: false, user: null });
    const reduxDispatch = useDispatch();
    const session = useSelector(selectSession);

    useEffect(() => {
        const loadSessionFromStorage = async () => {
            const storedSession = await getData('session');
            if (storedSession) {
                dispatch({ type: 'LOGIN', payload: storedSession.user });
                reduxDispatch(loadSession(storedSession));
            }
        };

        loadSessionFromStorage();
    }, [reduxDispatch]);

    useEffect(() => {
        const validateUserSession = async () => {
            try {
                const isValid = await validateSession();
                if (!isValid) {
                    dispatch({ type: 'LOGOUT' });
                    reduxDispatch(logout());
                }
            } catch (error) {
                console.error('Error validating session:', error);
            }
        };

        if (state.isAuthenticated) {
            validateUserSession();
        }
    }, [state.isAuthenticated, reduxDispatch]);

    // Define fake sessions
    const fakeSessions = [
        {
            id: '679f4993e38393a3a9edd4dd',
            name: { first: 'Nate', last: 'Isern' },
            username: 'nate',
            avatarSource: { uri: 'https://api.mention.earth/api/files/6790749544634262da8394f2' },
        },
        {
            id: '679fcac00e2353edc2f02f19',
            name: { first: 'Mention' },
            username: 'mention',
            avatarSource: { uri: 'http://localhost:8081/assets/?unstable_path=.%2Fassets%2Fimages/default-avatar.jpg' },
        }
    ];

    const switchSession = (sessionId: string) => {
        const session = fakeSessions.find(s => s.id === sessionId);
        if (session) {
            loginUser(session);
        }
    };

    const loginUser = (user) => {
        dispatch({ type: 'LOGIN', payload: user });
        reduxDispatch(login(user));
    };

    const logoutUser = () => {
        dispatch({ type: 'LOGOUT' });
        reduxDispatch(logout());
    };

    const getCurrentUser = () => {
        return state.user ? state.user : null;
    };

    return (
        <SessionContext.Provider value={{ state, loginUser, logoutUser, getCurrentUser, sessions: fakeSessions, switchSession }}>
            {children}
        </SessionContext.Provider>
    );
};

export { SessionProvider, SessionContext };
