import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { oxyClient } from '../../../services/OxyClient';
import { Session } from '../types';

export const useSessions = (mode: string) => {
    const [sessions, setSessions] = useState<Session[]>([]);
    const [isLoadingSessions, setIsLoadingSessions] = useState(false);
    const { t } = useTranslation();

    useEffect(() => {
        const loadSessions = async () => {
            setIsLoadingSessions(true);
            try {
                const response = await oxyClient.getSessions();
                setSessions(response.sessions);
            } catch (error) {
                console.error('Error loading sessions:', error);
                toast.error(t('Failed to load sessions'));
            } finally {
                setIsLoadingSessions(false);
            }
        };

        if (mode === 'session') {
            loadSessions();
        }
    }, [mode, t]);

    return { sessions, isLoadingSessions };
};