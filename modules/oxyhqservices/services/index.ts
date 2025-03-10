/**
 * OxyHQ Services
 * 
 * This file exports all services for interacting with the OxyHQ API.
 * These services provide core functionality for authentication, data fetching,
 * and other backend operations.
 */

// Core Services
export { apiService } from './api.service';

// Client Services
export { OxyClient } from './OxyClient';

// Import service types for type safety
import { OxyClient as OxyClientType } from './OxyClient';
import { authService as AuthServiceType } from './auth.service';
import { userService as UserServiceType } from './user.service';
import { profileService as ProfileServiceType } from './profile.service';
import { paymentService as PaymentServiceType } from './payment.service';
import { subscriptionService as SubscriptionServiceType } from './subscription.service';
import { privacyService as PrivacyServiceType } from './privacy.service';

// Singleton instances - lazy loaded
let _oxyClient: OxyClientType | null = null;
let _authService: typeof AuthServiceType | null = null;
let _userService: typeof UserServiceType | null = null;
let _profileService: typeof ProfileServiceType | null = null;
let _paymentService: typeof PaymentServiceType | null = null;
let _subscriptionService: typeof SubscriptionServiceType | null = null;
let _privacyService: typeof PrivacyServiceType | null = null;

// Lazy loaded service getters
export const getOxyClient = (): OxyClientType => {
  if (!_oxyClient) {
    const { OxyClient } = require('./OxyClient');
    _oxyClient = new OxyClient();
  }
  return _oxyClient!;
};

export const getAuthService = (): typeof AuthServiceType => {
  if (!_authService) {
    const { authService } = require('./auth.service');
    _authService = authService;
  }
  return _authService!;
};

export const getUserService = (): typeof UserServiceType => {
  if (!_userService) {
    const { userService } = require('./user.service');
    _userService = userService;
  }
  return _userService!;
};

export const getProfileService = (): typeof ProfileServiceType => {
  if (!_profileService) {
    const { profileService } = require('./profile.service');
    _profileService = profileService;
  }
  return _profileService!;
};

export const getPaymentService = (): typeof PaymentServiceType => {
  if (!_paymentService) {
    const { paymentService } = require('./payment.service');
    _paymentService = paymentService;
  }
  return _paymentService!;
};

export const getSubscriptionService = (): typeof SubscriptionServiceType => {
  if (!_subscriptionService) {
    const { subscriptionService } = require('./subscription.service');
    _subscriptionService = subscriptionService;
  }
  return _subscriptionService!;
};

export const getPrivacyService = (): typeof PrivacyServiceType => {
  if (!_privacyService) {
    const { privacyService } = require('./privacy.service');
    _privacyService = privacyService;
  }
  return _privacyService!;
};

// For backwards compatibility
export { getOxyClient as oxyClient };
export { getAuthService as authService };
export { getUserService as userService };
export { getProfileService as profileService };
export { getPaymentService as paymentService };
export { getSubscriptionService as subscriptionService };
export { getPrivacyService as privacyService };