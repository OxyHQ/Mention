import React, { useState } from "react";
import { View, Text, StyleSheet, SafeAreaView, TextInput, TouchableOpacity, FlatList } from "react-native";
import { useTranslation } from "react-i18next";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons'; // added import for icons
import { Header } from "@/components/Header";
import { toast } from "@/lib/sonner"; // import toast
import { colors } from "@/styles/colors";

export default function LanguageSettings() {
    const { t, i18n } = useTranslation();
    const [selectedLanguage, setSelectedLanguage] = useState(i18n.language);
    const [searchQuery, setSearchQuery] = useState("");

    // Extended list of languages
    const languages = [
        { label: "English (US)", value: "en-US" },
        { label: "English (UK)", value: "en-GB" },
        { label: "English (Australia)", value: "en-AU" },
        { label: "English (Canada)", value: "en-CA" },
        { label: "Español (España)", value: "es-ES" },
        { label: "Català (Catalunya)", value: "ca-ES" },
        { label: "Español (México)", value: "es-MX" },
        { label: "Español (Latinoamérica)", value: "es-419" },
        { label: "Français (France)", value: "fr-FR" },
        { label: "Français (Canada)", value: "fr-CA" },
        { label: "Français (Belgique)", value: "fr-BE" },
        { label: "Deutsch (Deutschland)", value: "de-DE" },
        { label: "Deutsch (Österreich)", value: "de-AT" },
        { label: "Deutsch (Schweiz)", value: "de-CH" },
        { label: "Italiano", value: "it-IT" },
        { label: "Nederlands (Nederland)", value: "nl-NL" },
        { label: "Nederlands (België)", value: "nl-BE" },
        { label: "Português (Portugal)", value: "pt-PT" },
        { label: "Português (Brasil)", value: "pt-BR" },
        { label: "Português (Angola)", value: "pt-AO" },
        { label: "简体中文", value: "zh-CN" },
        { label: "繁體中文", value: "zh-TW" },
        { label: "中文 (香港)", value: "zh-HK" },
        { label: "日本語", value: "ja-JP" },
        { label: "한국어", value: "ko-KR" },
        { label: "Русский", value: "ru-RU" },
        { label: "Polski", value: "pl-PL" },
        { label: "Ελληνικά", value: "el-GR" },
        { label: "Svenska", value: "sv-SE" },
        { label: "Dansk", value: "da-DK" },
        { label: "Suomi", value: "fi-FI" },
        { label: "Norsk", value: "no-NO" },
        { label: "Čeština", value: "cs-CZ" },
        { label: "Română", value: "ro-RO" },
        { label: "Magyar", value: "hu-HU" },
        { label: "Slovenčina", value: "sk-SK" },
        { label: "Slovenščina", value: "sl-SI" },
        { label: "Hrvatski", value: "hr-HR" },
        { label: "Български", value: "bg-BG" },
        { label: "Українська", value: "uk-UA" },
        { label: "Հայերեն", value: "hy-AM" },
        { label: "ქართული", value: "ka-GE" },
        { label: "ไทย", value: "th-TH" },
        { label: "עברית", value: "he-IL" },
        { label: "العربية (السعودية)", value: "ar-SA" },
        { label: "العربية (مصر)", value: "ar-EG" },
        { label: "हिन्दी", value: "hi-IN" },
        { label: "বাংলা", value: "bn-IN" },
        { label: "اردو", value: "ur-PK" },
        { label: "Türkçe", value: "tr-TR" },
        { label: "Tiếng Việt", value: "vi-VN" },
        { label: "Bahasa Indonesia", value: "id-ID" },
        { label: "Bahasa Melayu", value: "ms-MY" },
        { label: "தமிழ்", value: "ta-IN" },
        { label: "తెలుగు", value: "te-IN" },
        { label: "ಕನ್ನಡ", value: "kn-IN" },
        { label: "മലയാളം", value: "ml-IN" },
        { label: "मराठी", value: "mr-IN" },
        { label: "ગુજરાતી", value: "gu-IN" },
        { label: "ਪੰਜਾਬੀ", value: "pa-IN" },
        { label: "Nepali", value: "ne-NP" },
        { label: "Sinhala", value: "si-LK" },
        { label: "Burmese", value: "my-MM" },
        { label: "Khmer", value: "km-KH" },
        { label: "Lao", value: "lo-LA" },
        { label: "Macedonian", value: "mk-MK" },
        { label: "Albanian", value: "sq-AL" },
        { label: "Bosnian", value: "bs-BA" },
        { label: "Swahili", value: "sw-KE" },
        { label: "Afrikaans", value: "af-ZA" },
        { label: "Amharic", value: "am-ET" },
    ];

    // Filter languages based on search
    const filteredLanguages = languages.filter(lang =>
        lang.label.toLowerCase().includes(searchQuery.toLowerCase())
    );

    // Auto-save language on selection
    const selectLanguage = async (language: string) => {
        setSelectedLanguage(language);
        await i18n.changeLanguage(language);
        await AsyncStorage.setItem('selectedLanguage', language);
        const selectedLangLabel = languages.find(lang => lang.value === selectedLanguage)?.label;
        toast(`${t("Language saved")}: ${selectedLangLabel}`, {
            icon: <Ionicons name="language" size={24} color={colors.primaryColor} />,
            description: t("Your language preference has been updated.")
        });
    };

    const renderItem = ({ item }: { item: typeof languages[0] }) => (
        <TouchableOpacity
            style={[
                styles.languageItem,
                selectedLanguage === item.value && styles.selectedItem
            ]}
            onPress={() => selectLanguage(item.value)}
        >
            <View style={styles.itemRow}>
                <Text style={styles.languageLabel}>{item.label}</Text>
                {selectedLanguage === item.value && (
                    <Ionicons name="checkmark-circle" size={24} color={colors.primaryColor} />
                )}
            </View>
        </TouchableOpacity>
    );

    return (
        <SafeAreaView style={styles.container}>
            <Header options={{
                title: t("Language Settings"),
                showBackButton: true,
            }} />
            <View style={styles.searchContainer}>
                <TextInput
                    style={styles.searchInput}
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    placeholder={t("Search Languages")}
                />
            </View>
            <FlatList
                data={filteredLanguages}
                keyExtractor={item => item.value}
                renderItem={renderItem}
                contentContainerStyle={styles.listContainer}
            />
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 16,
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        marginBottom: 16,
    },
    searchContainer: {
        padding: 8,
    },
    searchInput: {
        height: 40,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
        borderWidth: 1,
        borderRadius: 35,
        paddingHorizontal: 10,
    },
    listContainer: {
        paddingBottom: 16,
    },
    languageItem: {
        backgroundColor: '#fff',
        padding: 10,
        marginVertical: 4,
        marginHorizontal: 10,
        borderRadius: 12,
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 2,
    },
    selectedItem: {
        borderColor: colors.primaryColor,
        borderWidth: 2,
        borderRadius: 30,
    },
    languageLabel: {
        fontSize: 18,
    },
    itemRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
    },
});
