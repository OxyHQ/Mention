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
        <SessionContext.Provider value={{ state, loginUser, logoutUser, getCurrentUser }}>
            {children}
        </SessionContext.Provider>
    );
};

export { SessionProvider, SessionContext };
