import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet, SafeAreaView, ScrollView, TouchableOpacity } from "react-native";
import { useTranslation } from "react-i18next";
import { Header } from "@/components/Header";

const logMessages: { type: string, message: string }[] = [];

const captureConsole = (type: 'log' | 'warn' | 'error') => {
    const original = console[type];
    console[type] = (...args) => {
        logMessages.push({ type, message: `[${type.toUpperCase()}] ${args.join(" ")}` });
        original(...args);
    };
};

captureConsole('log');
captureConsole('warn');
captureConsole('error');

export default function LogSettings() {
    const { t } = useTranslation();
    const [logData, setLogData] = useState<{ type: string, message: string }[]>([]);

    useEffect(() => {
        setLogData([...logMessages]);
    }, []);

    const clearLogs = () => {
        logMessages.length = 0;
        setLogData([]);
    };

    const getLogStyle = (type: string) => {
        switch (type) {
            case 'warn':
                return styles.warnText;
            case 'error':
                return styles.errorText;
            default:
                return styles.logText;
        }
    };

    return (
        <SafeAreaView style={styles.container}>
            <Header options={{
                title: `${t("Log")}`, rightComponents: [<TouchableOpacity style={styles.clearButton} onPress={clearLogs}>
                    <Text style={styles.clearButtonText}>{t("Clear Logs")}</Text>
                </TouchableOpacity>]
            }} />
            <View style={styles.logContainer}>
                {logData.map((log, index) => (
                    <Text key={index} style={[styles.logTextBase, getLogStyle(log.type)]}>{log.message}</Text>
                ))}
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    clearButton: {
        backgroundColor: '#ff4444',
        paddingVertical: 5,
        paddingHorizontal: 15,
        borderRadius: 35,
    },
    clearButtonText: {
        color: '#fff',
        fontSize: 13,
        fontWeight: 'bold',
    },
    logContainer: {
        padding: 10,
        flex: 1,
    },
    logTextBase: {
        fontSize: 14,
        marginBottom: 5,
        padding: 10,
        borderWidth: 1,
        borderRadius: 16,
    },
    logText: {
        color: "#333",
        borderColor: "#ddd",
    },
    warnText: {
        color: "#856404",
        backgroundColor: "#fff3cd",
        borderColor: "#ffeeba",
    },
    errorText: {
        color: "#721c24",
        backgroundColor: "#f8d7da",
        borderColor: "#f5c6cb",
    },
});
