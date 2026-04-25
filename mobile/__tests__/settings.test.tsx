/**
 * Settings / Integrations screen regression tests
 *
 * Covers:
 *  1. Screen renders without crash (settings-content visible)
 *  2. All 3 provider cards appear (Lightspeed, Square, Clover)
 *  3. Screen does not hang when ALL provider endpoints throw errors (each
 *     catches independently — critical regression from original bug report)
 *  4. Provider cards show "Not connected" when status returns connected:false
 *  5. Provider cards show "Connected" when status returns connected:true
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(async () => ({ type: 'cancel' })),
}));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ status: 'denied' })),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true })),
}));

jest.mock('../tasks/backgroundSync', () => ({
  registerBackgroundSync: jest.fn(async () => undefined),
  unregisterBackgroundSync: jest.fn(async () => undefined),
}));

jest.mock('../context/auth', () => ({
  useAuth: () => ({
    user: {
      id: 'user-1',
      email: 'test@vendora.test',
      business_name: 'Test Shop',
      profile_picture: null,
      subscription_tier: 'pro',
      is_partner: false,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    },
    signOut: jest.fn(),
    refreshUser: jest.fn(async () => undefined),
  }),
}));

jest.mock('../services/api', () => ({
  getLightspeedStatus: jest.fn(),
  getSquareStatus: jest.fn(),
  getCloverStatus: jest.fn(),
  getProviderHealth: jest.fn(),
  getLightspeedConnectUrl: jest.fn(),
  triggerLightspeedSync: jest.fn(),
  triggerSquareSync: jest.fn(),
  triggerCloverSync: jest.fn(),
  connectSquare: jest.fn(),
  connectClover: jest.fn(),
  updateProfile: jest.fn(),
}));

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import SettingsScreen from '../app/(tabs)/settings';

const NOT_CONNECTED_LS = { connected: false, account_id: null, expires_at: null, last_synced_at: null };
const NOT_CONNECTED_SQ = { connected: false, merchant_id: null, location_id: null, last_synced_at: null };
const NOT_CONNECTED_CV = { connected: false, merchant_id: null, last_synced_at: null };
const EMPTY_HEALTH = { providers: [] };

function setupAllDisconnected() {
  (apiMock.getLightspeedStatus as jest.Mock).mockResolvedValue(NOT_CONNECTED_LS);
  (apiMock.getSquareStatus as jest.Mock).mockResolvedValue(NOT_CONNECTED_SQ);
  (apiMock.getCloverStatus as jest.Mock).mockResolvedValue(NOT_CONNECTED_CV);
  (apiMock.getProviderHealth as jest.Mock).mockResolvedValue(EMPTY_HEALTH);
}

function setupAllErrors() {
  (apiMock.getLightspeedStatus as jest.Mock).mockRejectedValue(new Error('404'));
  (apiMock.getSquareStatus as jest.Mock).mockRejectedValue(new Error('404'));
  (apiMock.getCloverStatus as jest.Mock).mockRejectedValue(new Error('404'));
  (apiMock.getProviderHealth as jest.Mock).mockRejectedValue(new Error('404'));
}

beforeEach(() => jest.clearAllMocks());

describe('SettingsScreen', () => {
  it('renders provider cards and exits loading when all APIs return disconnected', async () => {
    setupAllDisconnected();
    const { getByTestId, getAllByText } = render(<SettingsScreen />);

    await waitFor(() => {
      expect(getByTestId('settings-content')).toBeTruthy();
    });

    // All three provider names are present
    expect(getAllByText('Lightspeed').length).toBeGreaterThanOrEqual(1);
    expect(getAllByText('Square').length).toBeGreaterThanOrEqual(1);
    expect(getAllByText('Clover').length).toBeGreaterThanOrEqual(1);
  });

  it('does not hang or crash when all provider endpoints throw errors', async () => {
    setupAllErrors();
    const { getByTestId } = render(<SettingsScreen />);

    // The screen must settle (not hang forever) even when every API fails.
    await waitFor(() => {
      expect(getByTestId('settings-content')).toBeTruthy();
    }, { timeout: 5000 });
  });

  it('shows Not connected status for all providers when disconnected', async () => {
    setupAllDisconnected();
    const { getAllByText } = render(<SettingsScreen />);

    await waitFor(() => {
      const notConnected = getAllByText('Not connected');
      // 3 provider cards × 1 "Not connected" pill each
      expect(notConnected.length).toBe(3);
    });
  });

  it('shows Connected pill for Lightspeed when status returns connected:true', async () => {
    (apiMock.getLightspeedStatus as jest.Mock).mockResolvedValue({
      connected: true,
      account_id: 'ACC-99',
      expires_at: '2030-01-01T00:00:00Z',
      last_synced_at: null,
    });
    (apiMock.getSquareStatus as jest.Mock).mockResolvedValue(NOT_CONNECTED_SQ);
    (apiMock.getCloverStatus as jest.Mock).mockResolvedValue(NOT_CONNECTED_CV);
    (apiMock.getProviderHealth as jest.Mock).mockResolvedValue(EMPTY_HEALTH);

    const { getAllByText } = render(<SettingsScreen />);

    await waitFor(() => {
      const connectedPills = getAllByText('Connected');
      expect(connectedPills.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders user email and subscription tier', async () => {
    setupAllDisconnected();
    const { getByText } = render(<SettingsScreen />);

    await waitFor(() => {
      expect(getByText('test@vendora.test')).toBeTruthy();
      expect(getByText('PRO')).toBeTruthy();
    });
  });
});
