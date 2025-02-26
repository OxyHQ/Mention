import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
// Using a conditional import for DateTimePicker to avoid build errors
import { postData } from '@/utils/api';
import { colors } from '@/styles/colors';

// Mock DateTimePicker for web or when the module is not available
const DateTimePickerComponent = ({ value, onChange, mode, display, minimumDate, maximumDate }: any) => {
    if (Platform.OS === 'web') {
        return (
            <input
                type="date"
                value={value.toISOString().split('T')[0]}
                onChange={(e) => {
                    const date = new Date(e.target.value);
                    onChange({ type: 'set' }, date);
                }}
                min={minimumDate?.toISOString().split('T')[0]}
                max={maximumDate?.toISOString().split('T')[0]}
                style={{
                    padding: 10,
                    borderWidth: 1,
                    borderColor: colors.COLOR_BLACK_LIGHT_6,
                    borderRadius: 8,
                    marginBottom: 16
                }}
            />
        );
    }

    // For native platforms, try to use the actual DateTimePicker
    try {
        const DateTimePicker = require('@react-native-community/datetimepicker').default;
        return (
            <DateTimePicker
                value={value}
                mode={mode}
                display={display}
                onChange={onChange}
                minimumDate={minimumDate}
                maximumDate={maximumDate}
            />
        );
    } catch (error) {
        console.warn('DateTimePicker not available:', error);
        return null;
    }
};

interface CreatePollProps {
    postId: string;
    onPollCreated: (pollId: string) => void;
    onCancel: () => void;
}

export const CreatePoll: React.FC<CreatePollProps> = ({ postId, onPollCreated, onCancel }) => {
    const [question, setQuestion] = useState('');
    const [options, setOptions] = useState(['', '']);
    const [endDate, setEndDate] = useState(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)); // Default 7 days
    const [showDatePicker, setShowDatePicker] = useState(false);
    const [isMultipleChoice, setIsMultipleChoice] = useState(false);
    const [isAnonymous, setIsAnonymous] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    const addOption = () => {
        if (options.length < 4) {
            setOptions([...options, '']);
        } else {
            Alert.alert('Maximum Options', 'You can add up to 4 options for a poll.');
        }
    };

    const removeOption = (index: number) => {
        if (options.length > 2) {
            const newOptions = [...options];
            newOptions.splice(index, 1);
            setOptions(newOptions);
        } else {
            Alert.alert('Minimum Options', 'A poll must have at least 2 options.');
        }
    };

    const updateOption = (text: string, index: number) => {
        const newOptions = [...options];
        newOptions[index] = text;
        setOptions(newOptions);
    };

    const onDateChange = (event: any, selectedDate?: Date) => {
        setShowDatePicker(false);
        if (selectedDate) {
            setEndDate(selectedDate);
        }
    };

    const validatePoll = () => {
        if (!question.trim()) {
            Alert.alert('Error', 'Please enter a poll question.');
            return false;
        }

        if (options.some(option => !option.trim())) {
            Alert.alert('Error', 'All options must have text.');
            return false;
        }

        if (new Set(options.map(o => o.trim())).size !== options.length) {
            Alert.alert('Error', 'All options must be unique.');
            return false;
        }

        if (endDate <= new Date()) {
            Alert.alert('Error', 'End date must be in the future.');
            return false;
        }

        return true;
    };

    const createPoll = async () => {
        if (!validatePoll()) return;

        setIsLoading(true);
        try {
            console.log('Creating poll with postId:', postId);
            const pollData = {
                question,
                options,
                postId,
                endsAt: endDate.toISOString(),
                isMultipleChoice,
                isAnonymous
            };
            console.log('Poll data:', pollData);

            const response = await postData('polls', pollData);
            console.log('Poll creation response:', response);

            if (response.success) {
                onPollCreated(response.data._id);
            } else {
                Alert.alert('Error', response.message || 'Failed to create poll');
            }
        } catch (error: any) {
            console.error('Error creating poll:', error);
            const errorMessage = error.response?.data?.message || error.message || 'Failed to create poll';
            Alert.alert('Error', `Failed to create poll: ${errorMessage}`);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>Create Poll</Text>
                <TouchableOpacity onPress={onCancel} style={styles.closeButton}>
                    <Ionicons name="close" size={24} color={colors.COLOR_BLACK} />
                </TouchableOpacity>
            </View>

            <ScrollView style={styles.content}>
                <Text style={styles.label}>Question</Text>
                <TextInput
                    style={styles.questionInput}
                    placeholder="Ask a question..."
                    value={question}
                    onChangeText={setQuestion}
                    maxLength={280}
                    multiline
                />

                <Text style={styles.label}>Options</Text>
                {options.map((option, index) => (
                    <View key={index} style={styles.optionContainer}>
                        <TextInput
                            style={styles.optionInput}
                            placeholder={`Option ${index + 1}`}
                            value={option}
                            onChangeText={(text) => updateOption(text, index)}
                            maxLength={100}
                        />
                        {options.length > 2 && (
                            <TouchableOpacity onPress={() => removeOption(index)} style={styles.removeButton}>
                                <Ionicons name="trash-outline" size={20} color="red" />
                            </TouchableOpacity>
                        )}
                    </View>
                ))}

                {options.length < 4 && (
                    <TouchableOpacity onPress={addOption} style={styles.addButton}>
                        <Ionicons name="add-circle-outline" size={20} color={colors.primaryColor} />
                        <Text style={styles.addButtonText}>Add Option</Text>
                    </TouchableOpacity>
                )}

                <Text style={styles.label}>Poll Duration</Text>
                <TouchableOpacity
                    style={styles.dateButton}
                    onPress={() => setShowDatePicker(true)}
                >
                    <Ionicons name="calendar-outline" size={20} color={colors.primaryColor} />
                    <Text style={styles.dateText}>
                        {endDate.toLocaleDateString()} ({Math.ceil((endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))} days)
                    </Text>
                </TouchableOpacity>

                {showDatePicker && (
                    <DateTimePickerComponent
                        value={endDate}
                        mode="date"
                        display="default"
                        onChange={onDateChange}
                        minimumDate={new Date(Date.now() + 24 * 60 * 60 * 1000)} // Minimum 1 day
                        maximumDate={new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)} // Maximum 7 days
                    />
                )}

                <View style={styles.optionsContainer}>
                    <TouchableOpacity
                        style={styles.optionToggle}
                        onPress={() => setIsMultipleChoice(!isMultipleChoice)}
                    >
                        <Ionicons
                            name={isMultipleChoice ? "checkbox" : "square-outline"}
                            size={24}
                            color={colors.primaryColor}
                        />
                        <Text style={styles.optionText}>Allow multiple choices</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.optionToggle}
                        onPress={() => setIsAnonymous(!isAnonymous)}
                    >
                        <Ionicons
                            name={isAnonymous ? "checkbox" : "square-outline"}
                            size={24}
                            color={colors.primaryColor}
                        />
                        <Text style={styles.optionText}>Anonymous voting</Text>
                    </TouchableOpacity>
                </View>
            </ScrollView>

            <View style={styles.footer}>
                <TouchableOpacity
                    style={[styles.button, styles.cancelButton]}
                    onPress={onCancel}
                    disabled={isLoading}
                >
                    <Text style={styles.buttonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                    style={[styles.button, styles.createButton, isLoading && styles.disabledButton]}
                    onPress={createPoll}
                    disabled={isLoading}
                >
                    <Text style={styles.buttonText}>
                        {isLoading ? 'Creating...' : 'Create Poll'}
                    </Text>
                </TouchableOpacity>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.primaryLight,
        borderRadius: 10,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    title: {
        fontSize: 18,
        fontWeight: 'bold',
        color: colors.COLOR_BLACK,
    },
    closeButton: {
        padding: 4,
    },
    content: {
        flex: 1,
        padding: 16,
    },
    label: {
        fontSize: 16,
        fontWeight: 'bold',
        marginTop: 16,
        marginBottom: 8,
        color: colors.COLOR_BLACK,
    },
    questionInput: {
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
        borderRadius: 8,
        padding: 12,
        fontSize: 16,
        minHeight: 80,
        textAlignVertical: 'top',
    },
    optionContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
    },
    optionInput: {
        flex: 1,
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
        borderRadius: 8,
        padding: 12,
        fontSize: 16,
    },
    removeButton: {
        marginLeft: 8,
        padding: 8,
    },
    addButton: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 8,
        marginBottom: 16,
    },
    addButtonText: {
        marginLeft: 8,
        color: colors.primaryColor,
        fontSize: 16,
    },
    dateButton: {
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
        borderRadius: 8,
        padding: 12,
    },
    dateText: {
        marginLeft: 8,
        fontSize: 16,
    },
    optionsContainer: {
        marginTop: 16,
    },
    optionToggle: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
    },
    optionText: {
        marginLeft: 8,
        fontSize: 16,
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        padding: 16,
        borderTopWidth: 1,
        borderTopColor: colors.COLOR_BLACK_LIGHT_6,
    },
    button: {
        flex: 1,
        borderRadius: 8,
        padding: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    cancelButton: {
        backgroundColor: colors.COLOR_BLACK_LIGHT_6,
        marginRight: 8,
    },
    createButton: {
        backgroundColor: colors.primaryColor,
        marginLeft: 8,
    },
    disabledButton: {
        opacity: 0.5,
    },
    buttonText: {
        color: colors.primaryLight,
        fontSize: 16,
        fontWeight: 'bold',
    },
});

export default CreatePoll; 