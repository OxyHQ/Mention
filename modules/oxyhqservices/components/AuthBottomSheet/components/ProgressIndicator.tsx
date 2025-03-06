import React from 'react';
import { View } from 'react-native';
import { sharedStyles } from './sharedStyles';
import { styles } from './styles';

interface ProgressIndicatorProps {
    currentStep: number;
}

export const ProgressIndicator: React.FC<ProgressIndicatorProps> = ({ currentStep }) => (
    <View style={sharedStyles.progressContainer}>
        {[1, 2, 3, 4].map((stepNum) => (
            <View key={stepNum} style={styles.progressWrapper}>
                <View
                    style={[
                        sharedStyles.progressDot,
                        stepNum === currentStep && sharedStyles.progressDotActive,
                        stepNum < currentStep && sharedStyles.progressDotCompleted,
                    ]}
                />
                {stepNum < 4 && (
                    <View
                        style={[
                            sharedStyles.progressLine,
                            stepNum < currentStep && sharedStyles.progressLineCompleted,
                        ]}
                    />
                )}
            </View>
        ))}
    </View>
);