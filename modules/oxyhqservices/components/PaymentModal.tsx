import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Alert,
  ActivityIndicator,
  Platform,
  TouchableOpacity,
  StyleSheet,
  ViewStyle,
  TextStyle,
} from 'react-native';
import { colors } from '@/styles/colors';
import { paymentService } from '../services/payment.service';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { BaseBottomSheet } from './BaseBottomSheet';
import { sharedStyles } from '../styles/shared';
import { ThemedText } from '@/components/ThemedText';
import { LinearGradient } from 'expo-linear-gradient';

interface PaymentModalProps {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
  plan: string;
  price: string;
  userId: string;
}

export function PaymentModal({ onClose, onSuccess, plan, price, userId }: PaymentModalProps) {
  const { t } = useTranslation();
  const [cardNumber, setCardNumber] = useState('');
  const [expiryMonth, setExpiryMonth] = useState('');
  const [expiryYear, setExpiryYear] = useState('');
  const [cvc, setCvc] = useState('');
  const [loading, setLoading] = useState(false);

  const handlePayment = async () => {
    try {
      setLoading(true);

      if (!cardNumber || !expiryMonth || !expiryYear || !cvc) {
        Alert.alert(t('Error'), t('Please fill in all payment details'));
        return;
      }

      const paymentMethod = {
        type: 'card' as const,
        cardNumber,
        expiryMonth,
        expiryYear,
        cvc,
      };

      const isValid = await paymentService.validatePaymentMethod(paymentMethod);
      if (!isValid) {
        Alert.alert(t('Error'), t('Invalid payment details'));
        return;
      }

      const response = await paymentService.processPayment(userId, plan, paymentMethod);

      if (response.success) {
        Alert.alert(
          t('Success'),
          t('Payment processed successfully'),
          [{ text: 'OK', onPress: onSuccess }]
        );
        onClose();
      } else {
        Alert.alert(t('Error'), response.error || t('Payment failed'));
      }
    } catch (error) {
      Alert.alert(t('Error'), t('Payment processing failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <BaseBottomSheet
      onClose={onClose}
      title={t('Payment Details')}
      showLogo={false}
    >
      <View style={sharedStyles.container}>
        <View style={sharedStyles.content}>
          <View style={styles.planInfo}>
            <ThemedText style={sharedStyles.title}>{plan}</ThemedText>
            <ThemedText style={styles.price}>{price}</ThemedText>
          </View>

          {Platform.OS === 'ios' && (
            <TouchableOpacity style={styles.applePayButton}>
              <Ionicons name="logo-apple" size={24} color="#fff" />
              <Text style={styles.applePayText}>{t('Pay with Apple Pay')}</Text>
            </TouchableOpacity>
          )}

          {Platform.OS === 'android' && (
            <TouchableOpacity style={styles.googlePayButton}>
              <Ionicons name="logo-google" size={24} color="#fff" />
              <Text style={styles.googlePayText}>{t('Pay with Google Pay')}</Text>
            </TouchableOpacity>
          )}

          <View style={styles.separator}>
            <View style={styles.line} />
            <Text style={styles.orText}>{t('or pay with card')}</Text>
            <View style={styles.line} />
          </View>

          <View style={styles.form}>
            <View style={sharedStyles.inputWrapper}>
              <TextInput
                style={sharedStyles.input}
                placeholder={t('Card number')}
                value={cardNumber}
                onChangeText={setCardNumber}
                keyboardType="number-pad"
                maxLength={16}
                placeholderTextColor={colors.COLOR_BLACK_LIGHT_4}
              />
            </View>
            <View style={styles.row}>
              <TextInput
                style={[sharedStyles.input, styles.smallInput]}
                placeholder={t('MM')}
                value={expiryMonth}
                onChangeText={setExpiryMonth}
                keyboardType="number-pad"
                maxLength={2}
                placeholderTextColor={colors.COLOR_BLACK_LIGHT_4}
              />
              <Text style={styles.separatorText}>/</Text>
              <TextInput
                style={[sharedStyles.input, styles.smallInput]}
                placeholder={t('YY')}
                value={expiryYear}
                onChangeText={setExpiryYear}
                keyboardType="number-pad"
                maxLength={2}
                placeholderTextColor={colors.COLOR_BLACK_LIGHT_4}
              />
              <TextInput
                style={[sharedStyles.input, styles.cvcInput]}
                placeholder={t('CVC')}
                value={cvc}
                onChangeText={setCvc}
                keyboardType="number-pad"
                maxLength={4}
                placeholderTextColor={colors.COLOR_BLACK_LIGHT_4}
              />
            </View>
          </View>

          <TouchableOpacity
            style={[sharedStyles.button, loading && styles.payButtonDisabled]}
            onPress={handlePayment}
            disabled={loading}
          >
            <LinearGradient
              colors={[colors.primaryColor, colors.primaryDark]}
              style={sharedStyles.buttonGradient}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
            >
              {loading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <ThemedText style={sharedStyles.buttonText}>
                  {t('Pay')} {price}
                </ThemedText>
              )}
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </View>
    </BaseBottomSheet>
  );
}

const styles = StyleSheet.create({
  planInfo: {
    marginBottom: 24,
  },
  price: {
    fontSize: 24,
    fontWeight: '600',
    color: colors.COLOR_BLACK,
    textAlign: 'center',
  },
  applePayButton: {
    backgroundColor: '#000',
    flexDirection: 'row',
    alignItems: 'center' as const,
    justifyContent: 'center',
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
  },
  applePayText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    marginLeft: 8,
  },
  googlePayButton: {
    backgroundColor: '#4285F4',
    flexDirection: 'row',
    alignItems: 'center' as const,
    justifyContent: 'center',
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
  },
  googlePayText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    marginLeft: 8,
  },
  separator: {
    flexDirection: 'row',
    alignItems: 'center' as const,
    marginVertical: 24,
  },
  line: {
    flex: 1,
    height: 1,
    backgroundColor: colors.COLOR_BLACK_LIGHT_6,
  },
  orText: {
    marginHorizontal: 16,
    color: colors.COLOR_BLACK_LIGHT_4,
  },
  form: {
    marginBottom: 24,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center' as const,
  },
  smallInput: {
    width: 60,
    marginRight: 8,
    textAlign: 'center' as const,
  },
  cvcInput: {
    width: 80,
    marginLeft: 16,
    textAlign: 'center' as const,
  },
  payButtonDisabled: {
    opacity: 0.7,
  },
  separatorText: {
    marginHorizontal: 4,
    color: colors.COLOR_BLACK_LIGHT_4,
    fontSize: 16,
  },
});