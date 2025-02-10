import React, { Component, ErrorInfo, ReactNode } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { colors } from '@/styles/colors';
import { withTranslation } from 'react-i18next';

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
    t: (key: string) => string;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

class ErrorBoundaryBase extends Component<Props, State> {
    public state: State = {
        hasError: false,
        error: null,
    };

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('Error caught by boundary:', error, errorInfo);
    }

    private handleRetry = () => {
        this.setState({ hasError: false, error: null });
    };

    render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }

            return (
                <View style={styles.container}>
                    <Text style={styles.title}>{this.props.t("error.boundary.title")}</Text>
                    <Text style={styles.message}>
                        {this.props.t("error.boundary.message")}
                    </Text>
                    <TouchableOpacity
                        style={styles.retryButton}
                        onPress={this.handleRetry}
                    >
                        <Text style={styles.retryText}>{this.props.t("error.boundary.retry")}</Text>
                    </TouchableOpacity>
                </View>
            );
        }

        return this.props.children;
    }
}

// Wrap the component with translation HOC
const ErrorBoundary = withTranslation()(ErrorBoundaryBase);

const styles = StyleSheet.create({
    container: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
    },
    title: {
        fontSize: 20,
        fontWeight: 'bold',
        marginBottom: 10,
        color: colors.primaryColor,
    },
    message: {
        fontSize: 16,
        textAlign: 'center',
        marginBottom: 20,
        color: colors.COLOR_BLACK_LIGHT_3,
    },
    retryButton: {
        backgroundColor: colors.primaryColor,
        paddingHorizontal: 20,
        paddingVertical: 10,
        borderRadius: 8,
    },
    retryText: {
        color: 'white',
        fontSize: 16,
        fontWeight: '600',
    },
});

export default ErrorBoundary;
