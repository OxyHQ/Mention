import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { colors } from '@/styles/colors';
import { paymentService } from '../services/payment.service';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';

interface PaymentModalProps {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
  plan: string;
  price: string;
  userId: string;
}

export function PaymentModal({ visible, onClose, onSuccess, plan, price, userId }: PaymentModalProps) {
  const { t } = useTranslation();
  const [cardNumber, setCardNumber] = useState('');
  const [expiryMonth, setExpiryMonth] = useState('');
  const [expiryYear, setExpiryYear] = useState('');
  const [cvc, setCvc] = useState('');
  const [loading, setLoading] = useState(false);

  const handlePayment = async () => {
    try {
      setLoading(true);

      // Basic validation
      if (!cardNumber || !expiryMonth || !expiryYear || !cvc) {
        Alert.alert(t('Error'), t('Please fill in all payment details'));
        return;
      }

      const paymentMethod = {
        type: 'card',
        cardNumber,
        expiryMonth,
        expiryYear,
        cvc,
      };

      // Validate payment method first
      const isValid = await paymentService.validatePaymentMethod(paymentMethod);
      if (!isValid) {
        Alert.alert(t('Error'), t('Invalid payment details'));
        return;
      }

      // Process payment
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
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('Payment Details')}</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Ionicons name="close" size={24} color={colors.COLOR_BLACK} />
            </TouchableOpacity>
          </View>

          <View style={styles.planInfo}>
            <Text style={styles.planName}>{t('Plan')}: {plan}</Text>
            <Text style={styles.price}>{price}</Text>
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
            <TextInput
              style={styles.input}
              placeholder={t('Card number')}
              value={cardNumber}
              onChangeText={setCardNumber}
              keyboardType="number-pad"
              maxLength={16}
            />
            <View style={styles.row}>
              <TextInput
                style={[styles.input, styles.smallInput]}
                placeholder={t('MM')}
                value={expiryMonth}
                onChangeText={setExpiryMonth}
                keyboardType="number-pad"
                maxLength={2}
              />
              <Text style={styles.separator}>/</Text>
              <TextInput
                style={[styles.input, styles.smallInput]}
                placeholder={t('YY')}
                value={expiryYear}
                onChangeText={setExpiryYear}
                keyboardType="number-pad"
                maxLength={2}
              />
              <TextInput
                style={[styles.input, styles.cvcInput]}
                placeholder={t('CVC')}
                value={cvc}
                onChangeText={setCvc}
                keyboardType="number-pad"
                maxLength={4}
              />
            </View>
          </View>

          <TouchableOpacity
            style={[styles.payButton, loading && styles.payButtonDisabled]}
            onPress={handlePayment}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.payButtonText}>
                {t('Pay')} {price}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    maxHeight: '90%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: colors.COLOR_BLACK,
  },
  closeButton: {
    padding: 8,
  },
  planInfo: {
    marginBottom: 24,
  },
  planName: {
    fontSize: 18,
    color: colors.COLOR_BLACK,
    marginBottom: 4,
  },
  price: {
    fontSize: 24,
    fontWeight: 'bold',
    color: colors.COLOR_BLACK,
  },
  applePayButton: {
    backgroundColor: '#000',
    flexDirection: 'row',
    alignItems: 'center',
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
    alignItems: 'center',
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
    alignItems: 'center',
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
  input: {
    backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    marginBottom: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  smallInput: {
    width: 60,
    marginRight: 8,
    textAlign: 'center',
  },
  cvcInput: {
    width: 80,
    marginLeft: 16,
    textAlign: 'center',
  },
  payButton: {
    backgroundColor: colors.primaryColor,
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  payButtonDisabled: {
    opacity: 0.7,
  },
  payButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
});