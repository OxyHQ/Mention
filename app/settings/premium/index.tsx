import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, SafeAreaView, Alert, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Header } from '@/components/Header';
import { colors } from '@/styles/colors';
import { Ionicons } from '@expo/vector-icons';
import { useSubscription } from '@/modules/oxyhqservices/hooks/useSubscription';
import { useSelector } from 'react-redux';
import type { RootState } from '@/store/store';
import { PaymentModal } from '@/modules/oxyhqservices/components/PaymentModal';
import { useAuth } from '@/modules/oxyhqservices/hooks';

interface PlanFeature {
  icon: string;
  title: string;
  description: string;
}

interface Plan {
  name: string;
  price: string;
  period: string;
  features: PlanFeature[];
  popular?: boolean;
}

export default function PremiumSettingsScreen() {
  const { t } = useTranslation();
  const { plan, loading, updateSubscription } = useSubscription();
  const [processingPlan, setProcessingPlan] = useState<string | null>(null);
  const [paymentModalVisible, setPaymentModalVisible] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<Plan | null>(null);
  const { user } = useAuth();
  const profile = useSelector((state: RootState) => state.profile.profile);

  const plans: Plan[] = [
    {
      name: 'Free',
      price: 'Free',
      period: '',
      features: [
        {
          icon: 'create',
          title: t('Basic Posts'),
          description: t('Create and share basic posts')
        }
      ]
    },
    {
      name: 'Mention+',
      price: '⊜2.99',
      period: '/month',
      features: [
        {
          icon: 'undo',
          title: t('Undo Posts'),
          description: t('Option to undo posts')
        },
        {
          icon: 'book',
          title: t('Improved Reading Mode'),
          description: t('Enhanced reading experience')
        },
        {
          icon: 'folder',
          title: t('Organize Bookmarks'),
          description: t('Organize bookmarked posts into folders')
        },
        {
          icon: 'rocket',
          title: t('Early Access'),
          description: t('Early access to select features')
        }
      ]
    },
    {
      name: 'Oxy+ Insider',
      price: '⊜4.99',
      period: '/month',
      features: [
        {
          icon: 'star',
          title: t('Exclusive Content'),
          description: t('Access to exclusive content and features')
        },
        {
          icon: 'rocket',
          title: t('Early Access'),
          description: t('Early access to new features')
        },
        {
          icon: 'support',
          title: t('Dedicated Support'),
          description: t('Access to a dedicated support team')
        }
      ]
    },
    {
      name: 'Oxy+ Connect',
      price: '⊜6.99',
      period: '/month',
      features: [
        {
          icon: 'group',
          title: t('Private Groups'),
          description: t('Create and join private groups')
        },
        {
          icon: 'search',
          title: t('Advanced Search'),
          description: t('Access to advanced search and filtering tools')
        },
        {
          icon: 'profile',
          title: t('Profile Customization'),
          description: t('Customize profile to highlight interests and connections')
        }
      ]
    },
    {
      name: 'Oxy+ Premium',
      price: '⊜9.99',
      period: '/month',
      features: [
        {
          icon: 'support',
          title: t('Priority Support'),
          description: t('Priority customer support')
        },
        {
          icon: 'premium',
          title: t('Premium Content'),
          description: t('Access to premium content and events')
        }
      ]
    },
    {
      name: 'Oxy+ Creator',
      price: '⊜14.99',
      period: '/month',
      features: [
        {
          icon: 'analytics',
          title: t('Advanced Analytics'),
          description: t('Access to advanced analytics and insights')
        },
        {
          icon: 'promotion',
          title: t('Promotional Tools'),
          description: t('Access to promotional tools and resources')
        },
        {
          icon: 'monetization',
          title: t('Monetize Content'),
          description: t('Ability to monetize content')
        }
      ]
    }
  ];

  const singleFeatures: Plan[] = [
    {
      name: 'Analytics',
      price: '⊜1.99',
      period: '/month',
      features: [
        {
          icon: 'analytics',
          title: t('Advanced Analytics'),
          description: t('Access to advanced analytics and insights')
        }
      ]
    },
    {
      name: 'Undo Posts',
      price: '⊜0.99',
      period: '/month',
      features: [
        {
          icon: 'undo',
          title: t('Undo Posts'),
          description: t('Option to undo posts')
        }
      ]
    },
    {
      name: 'Improved Reading Mode',
      price: '⊜0.99',
      period: '/month',
      features: [
        {
          icon: 'book',
          title: t('Improved Reading Mode'),
          description: t('Enhanced reading experience')
        }
      ]
    },
    {
      name: 'Organize Bookmarks',
      price: '⊜0.99',
      period: '/month',
      features: [
        {
          icon: 'folder',
          title: t('Organize Bookmarks'),
          description: t('Organize bookmarked posts into folders')
        }
      ]
    },
    {
      name: 'Early Access',
      price: '⊜1.49',
      period: '/month',
      features: [
        {
          icon: 'rocket',
          title: t('Early Access'),
          description: t('Early access to select features')
        }
      ]
    }
  ];

  const handleSubscribe = async (planData: Plan) => {
    if (planData.price === 'Free') {
      try {
        setProcessingPlan(planData.name.toLowerCase());
        await updateSubscription(planData.name.toLowerCase() as "basic" | "pro" | "business");
        Alert.alert(
          t('Plan Updated'),
          t('Your plan has been successfully updated to {{plan}}', { plan: planData.name }),
          [{ text: 'OK' }]
        );
      } catch (error) {
        Alert.alert(
          t('Error'),
          t('Failed to update plan. Please try again.'),
          [{ text: 'OK' }]
        );
      } finally {
        setProcessingPlan(null);
      }
    } else {
      setSelectedPlan(planData);
      setPaymentModalVisible(true);
    }
  };

  const handlePaymentSuccess = async () => {
    if (!selectedPlan) return;
    
    try {
      await updateSubscription(selectedPlan.name.toLowerCase() as "basic" | "pro" | "business");
    } catch (error) {
      Alert.alert(
        t('Error'),
        t('Failed to activate subscription. Please contact support.'),
        [{ text: 'OK' }]
      );
    }
  };

  const renderFeature = ({ icon, title, description }: PlanFeature) => (
    <View style={styles.feature} key={title}>
      <View style={styles.featureIcon}>
        <Ionicons name={icon as any} size={24} color={colors.primaryColor} />
      </View>
      <View style={styles.featureText}>
        <Text style={styles.featureTitle}>{title}</Text>
        <Text style={styles.featureDescription}>{description}</Text>
      </View>
    </View>
  );

  const renderPlan = (planData: Plan) => (
    <View style={[styles.planCard, planData.popular && styles.popularPlan]} key={planData.name}>
      {planData.popular && (
        <View style={styles.popularBadge}>
          <Text style={styles.popularText}>{t('Most Popular')}</Text>
        </View>
      )}
      <Text style={styles.planName}>{planData.name}</Text>
      <View style={styles.priceContainer}>
        <Text style={styles.price}>{planData.price}</Text>
        <Text style={styles.period}>{planData.period}</Text>
      </View>
      <View style={styles.featuresContainer}>
        {planData.features.map(renderFeature)}
      </View>
      <TouchableOpacity 
        style={[
          styles.subscribeButton, 
          planData.popular && styles.popularButton,
          plan.toLowerCase() === planData.name.toLowerCase() && styles.currentPlanButton
        ]}
        onPress={() => handleSubscribe(planData)}
        disabled={plan.toLowerCase() === planData.name.toLowerCase() || processingPlan !== null}
      >
        <Text style={[
          styles.subscribeButtonText, 
          planData.popular && styles.popularButtonText,
          plan.toLowerCase() === planData.name.toLowerCase() && styles.currentPlanText
        ]}>
          {processingPlan === planData.name.toLowerCase() ? (
            <ActivityIndicator color={planData.popular ? '#fff' : colors.primaryColor} size="small" />
          ) : plan.toLowerCase() === planData.name.toLowerCase() ? (
            t('Current Plan')
          ) : (
            t('Subscribe')
          )}
        </Text>
      </TouchableOpacity>
    </View>
  );

  const renderSingleFeature = (featureData: Plan) => (
    <View style={styles.singleFeatureCard} key={featureData.name}>
      <Text style={styles.planName}>{featureData.name}</Text>
      <View style={styles.priceContainer}>
        <Text style={styles.price}>{featureData.price}</Text>
        <Text style={styles.period}>{featureData.period}</Text>
      </View>
      <TouchableOpacity 
        style={[
          styles.subscribeButton, 
          plan.toLowerCase() === featureData.name.toLowerCase() && styles.currentPlanButton
        ]}
        onPress={() => handleSubscribe(featureData)}
        disabled={plan.toLowerCase() === featureData.name.toLowerCase() || processingPlan !== null}
      >
        <Text style={[
          styles.subscribeButtonText, 
          plan.toLowerCase() === featureData.name.toLowerCase() && styles.currentPlanText
        ]}>
          {processingPlan === featureData.name.toLowerCase() ? (
            <ActivityIndicator color={colors.primaryColor} size="small" />
          ) : plan.toLowerCase() === featureData.name.toLowerCase() ? (
            t('Current Plan')
          ) : (
            t('Subscribe')
          )}
        </Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <Header 
        options={{
          title: t('Premium Plans'),
          showBackButton: true,
        }} 
      />
      <ScrollView style={styles.scrollView}>
        <Text style={styles.title}>{t('Choose Your Plan')}</Text>
        <Text style={styles.subtitle}>
          {t('Unlock premium features and enhance your experience')}
        </Text>
        {plans.map(renderPlan)}
        <Text style={styles.title}>{t('Single Features')}</Text>
        <View style={styles.singleFeaturesGrid}>
          {singleFeatures.map(renderSingleFeature)}
        </View>
      </ScrollView>

      {user && selectedPlan && (
        <PaymentModal
          visible={paymentModalVisible}
          onClose={() => {
            setPaymentModalVisible(false);
            setSelectedPlan(null);
          }}
          onSuccess={handlePaymentSuccess}
          plan={selectedPlan.name}
          price={selectedPlan.price}
          userId={user.id}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  scrollView: {
    padding: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 8,
    color: colors.COLOR_BLACK,
  },
  subtitle: {
    fontSize: 16,
    color: colors.COLOR_BLACK_LIGHT_4,
    marginBottom: 24,
  },
  planCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
    position: 'relative',
  },
  popularPlan: {
    borderColor: colors.primaryColor,
    borderWidth: 2,
  },
  popularBadge: {
    position: 'absolute',
    top: -12,
    right: 24,
    backgroundColor: colors.primaryColor,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  popularText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  planName: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 8,
    color: colors.COLOR_BLACK,
  },
  priceContainer: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: 24,
  },
  price: {
    fontSize: 32,
    fontWeight: 'bold',
    color: colors.COLOR_BLACK,
  },
  period: {
    fontSize: 16,
    color: colors.COLOR_BLACK_LIGHT_4,
    marginLeft: 4,
  },
  featuresContainer: {
    marginBottom: 24,
  },
  feature: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  featureIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  featureText: {
    flex: 1,
  },
  featureTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
    color: colors.COLOR_BLACK,
  },
  featureDescription: {
    fontSize: 14,
    color: colors.COLOR_BLACK_LIGHT_4,
  },
  subscribeButton: {
    backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    paddingVertical: 12,
    borderRadius: 24,
    alignItems: 'center',
  },
  popularButton: {
    backgroundColor: colors.primaryColor,
  },
  subscribeButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.COLOR_BLACK,
  },
  popularButtonText: {
    color: '#fff',
  },
  currentPlanButton: {
    backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    opacity: 0.7,
  },
  currentPlanText: {
    color: colors.COLOR_BLACK_LIGHT_4,
  },
  singleFeaturesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  singleFeatureCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
    width: '48%',
    alignItems: 'center',
  },
});