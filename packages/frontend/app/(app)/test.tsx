import { Text, Button } from 'react-native';
import { ThemedView } from '@/components/ThemedView';

import { api } from '@/utils/api';

const handleTest = async () => {
    try {
        const response = await api.get('/test');
        console.log('API response:', response);
    } catch (error: any) {
        if (error.response) {
            // The request was made and the server responded with a status code outside 2xx
            console.error('API Error:', error.response.status, error.response.data);
        } else if (error.request) {
            // The request was made but no response was received
            console.error('No response received:', error.request);
        } else {
            // Something happened in setting up the request
            console.error('Error:', error.message);
        }
    }
};


const TestScreen = () => {
    return (
        <ThemedView>
            <Text>Test</Text>
            <Button title="Test" onPress={handleTest} />
        </ThemedView>
    );
};

export default TestScreen;