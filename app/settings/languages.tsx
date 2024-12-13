import React, { useState } from "react";
import { View, Text, StyleSheet, SafeAreaView, Button } from "react-native";
import { Picker } from "@react-native-picker/picker";
import { useTranslation } from "react-i18next";
import AsyncStorage from '@react-native-async-storage/async-storage';

export default function LanguageSettings() {
    const { t, i18n } = useTranslation();
    const [selectedLanguage, setSelectedLanguage] = useState(i18n.language);

    const changeLanguage = async (language: string) => {
        await i18n.changeLanguage(language);
        setSelectedLanguage(language);
        await AsyncStorage.setItem('selectedLanguage', language);
    };

    return (
        <SafeAreaView style={styles.container}>
            <Text style={styles.title}>{t("Language Settings")}</Text>
            <View style={styles.pickerContainer}>
                <Text style={styles.label}>{t("Select Language")}</Text>
                <Picker
                    selectedValue={selectedLanguage}
                    style={styles.picker}
                    onValueChange={(itemValue: string) => changeLanguage(itemValue)}
                >
                    <Picker.Item label="English" value="en" />
                    <Picker.Item label="Spanish" value="es" />
                    {/* Add more languages here */}
                </Picker>
            </View>
            <Button title={t("Save")} onPress={() => {/* Save language settings */ }} />
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 16,
        backgroundColor: '#fff',
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        marginBottom: 16,
    },
    pickerContainer: {
        marginBottom: 16,
    },
    label: {
        fontSize: 18,
        marginBottom: 8,
    },
    picker: {
        height: 50,
        width: '100%',
    },
});
