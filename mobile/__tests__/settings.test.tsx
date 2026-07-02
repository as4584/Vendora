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

import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import * as ImagePicker from 'expo-image-picker';
import * as apiMock from '../services/api';
import * as backgroundSync from '../tasks/backgroundSync';
import SettingsScreen from '../app/(tabs)/settings';

const mockPush = jest.fn();
const mockSignOut = jest.fn();
const mockRefreshUser = jest.fn();
let mockIsPartner = false;

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));

jest.mock('expo-web-browser', () => ({
  openAuthSessionAsync: jest.fn(async () => ({ type: 'cancel' })),
}));

jest.mock('expo-linking', () => ({
  createURL: jest.fn(() => 'vendora://settings'),
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
      is_partner: mockIsPartner,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    },
    signOut: mockSignOut,
    refreshUser: mockRefreshUser,
  }),
}));

jest.mock('../services/api', () => ({
  getLightspeedStatus: jest.fn(),
  getSquareStatus: jest.fn(),
  getCloverStatus: jest.fn(),
  getEbayStatus: jest.fn(),
  getProviderHealth: jest.fn(),
  getLightspeedConnectUrl: jest.fn(),
  triggerLightspeedSync: jest.fn(),
  pushLightspeedInventory: jest.fn(),
  disconnectLightspeed: jest.fn(),
  triggerSquareSync: jest.fn(),
  triggerCloverSync: jest.fn(),
  getEbayConnectUrl: jest.fn(),
  triggerEbaySync: jest.fn(),
  disconnectEbay: jest.fn(),
  connectSquare: jest.fn(),
  connectClover: jest.fn(),
  updateProfile: jest.fn(),
  deleteAccount: jest.fn(),
}));

const NOT_CONNECTED_LS = { connected: false, account_id: null, expires_at: null, last_synced_at: null };
const NOT_CONNECTED_SQ = { connected: false, merchant_id: null, location_id: null, last_synced_at: null };
const NOT_CONNECTED_CV = { connected: false, merchant_id: null, last_synced_at: null };
const NOT_CONNECTED_EB = { connected: false, account_id: null, expires_at: null, last_synced_at: null };
const EMPTY_HEALTH = { providers: [] };

function setupAllDisconnected() {
  (apiMock.getLightspeedStatus as jest.Mock).mockResolvedValue(NOT_CONNECTED_LS);
  (apiMock.getSquareStatus as jest.Mock).mockResolvedValue(NOT_CONNECTED_SQ);
  (apiMock.getCloverStatus as jest.Mock).mockResolvedValue(NOT_CONNECTED_CV);
  (apiMock.getEbayStatus as jest.Mock).mockResolvedValue(NOT_CONNECTED_EB);
  (apiMock.getProviderHealth as jest.Mock).mockResolvedValue(EMPTY_HEALTH);
}

function setupAllErrors() {
  (apiMock.getLightspeedStatus as jest.Mock).mockRejectedValue(new Error('404'));
  (apiMock.getSquareStatus as jest.Mock).mockRejectedValue(new Error('404'));
  (apiMock.getCloverStatus as jest.Mock).mockRejectedValue(new Error('404'));
  (apiMock.getEbayStatus as jest.Mock).mockRejectedValue(new Error('404'));
  (apiMock.getProviderHealth as jest.Mock).mockRejectedValue(new Error('404'));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  mockSignOut.mockResolvedValue(undefined);
  mockRefreshUser.mockResolvedValue(undefined);
  mockIsPartner = false;
});

afterEach(async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  jest.restoreAllMocks();
});

describe('SettingsScreen', () => {
  it('opens the partner public storefront', async () => {
    mockIsPartner = true;
    setupAllDisconnected();
    const screen = render(<SettingsScreen />);
    await screen.findByText('View Public Storefront');
    fireEvent.press(screen.getByText('View Public Storefront'));
    expect(mockPush).toHaveBeenCalledWith('/seller/user-1');
  });
  it('opens the completed product routes', async () => {
    setupAllDisconnected();
    const screen = render(<SettingsScreen />);
    await screen.findByText('Plans & Billing');
    fireEvent.press(screen.getByText('Plans & Billing'));
    fireEvent.press(screen.getByText('Advanced Analytics'));
    fireEvent.press(screen.getByText('Support'));
    expect(mockPush).toHaveBeenCalledWith('/settings/subscription');
    expect(mockPush).toHaveBeenCalledWith('/settings/analytics');
    expect(mockPush).toHaveBeenCalledWith('/settings/support');
  });

  it('pushes linked Lightspeed inventory and disconnects safely', async () => {
    (apiMock.getLightspeedStatus as jest.Mock).mockResolvedValue({ connected: true, account_id: 'acc', expires_at: '2030-01-01', last_synced_at: null });
    (apiMock.getSquareStatus as jest.Mock).mockResolvedValue(NOT_CONNECTED_SQ);
    (apiMock.getCloverStatus as jest.Mock).mockResolvedValue(NOT_CONNECTED_CV);
    (apiMock.getProviderHealth as jest.Mock).mockResolvedValue(EMPTY_HEALTH);
    (apiMock.pushLightspeedInventory as jest.Mock).mockResolvedValue({ items_updated: 2, errors_count: 1 });
    (apiMock.disconnectLightspeed as jest.Mock).mockResolvedValue({ disconnected: true, links_retained: 2 });
    (backgroundSync.unregisterBackgroundSync as jest.Mock).mockRejectedValueOnce(new Error('not registered'));
    const screen = render(<SettingsScreen />);
    await screen.findByText('Push to POS');
    fireEvent.press(screen.getByText('Push to POS'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Lightspeed updated', '2 linked items pushed to the POS. 1 failed.'));
    (Alert.alert as jest.Mock).mockImplementation((_title, _message, buttons) => buttons?.[1]?.onPress?.());
    fireEvent.press(screen.getByText('Disconnect'));
    await waitFor(() => expect(apiMock.disconnectLightspeed).toHaveBeenCalled());
  });

  it('reports Lightspeed push and disconnect failures', async () => {
    (apiMock.getLightspeedStatus as jest.Mock).mockResolvedValue({ connected: true, account_id: 'acc', expires_at: '2030-01-01', last_synced_at: null });
    (apiMock.getSquareStatus as jest.Mock).mockResolvedValue(NOT_CONNECTED_SQ);
    (apiMock.getCloverStatus as jest.Mock).mockResolvedValue(NOT_CONNECTED_CV);
    (apiMock.getProviderHealth as jest.Mock).mockResolvedValue(EMPTY_HEALTH);
    (apiMock.pushLightspeedInventory as jest.Mock).mockRejectedValue(new Error('push down'));
    (apiMock.disconnectLightspeed as jest.Mock).mockRejectedValue(new Error('disconnect down'));
    const screen = render(<SettingsScreen />); await screen.findByText('Push to POS'); fireEvent.press(screen.getByText('Push to POS'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Lightspeed push failed', 'push down'));
    (Alert.alert as jest.Mock).mockImplementation((_title, _message, buttons) => buttons?.[1]?.onPress?.());
    fireEvent.press(screen.getByText('Disconnect'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Disconnect failed', 'disconnect down'));
  });
  it('renders provider cards and exits loading when all APIs return disconnected', async () => {
    setupAllDisconnected();
    const { getByTestId, getAllByText } = render(<SettingsScreen />);

    await waitFor(() => {
      expect(getByTestId('settings-content')).toBeTruthy();
    });

    // All four provider names are present
    expect(getAllByText('Lightspeed').length).toBeGreaterThanOrEqual(1);
    expect(getAllByText('Square').length).toBeGreaterThanOrEqual(1);
    expect(getAllByText('Clover').length).toBeGreaterThanOrEqual(1);
    expect(getAllByText('eBay').length).toBeGreaterThanOrEqual(1);
  });

  it('does not hang or crash when all provider endpoints throw errors', async () => {
    setupAllErrors();
    const { getByTestId, getAllByText } = render(<SettingsScreen />);

    // The screen must settle (not hang forever) even when every API fails.
    await waitFor(() => {
      expect(getByTestId('settings-content')).toBeTruthy();
      expect(getAllByText('Not connected')).toHaveLength(4);
    }, { timeout: 5000 });
  });

  it('shows Not connected status for all providers when disconnected', async () => {
    setupAllDisconnected();
    const { getAllByText } = render(<SettingsScreen />);

    await waitFor(() => {
      const notConnected = getAllByText('Not connected');
      // 4 provider cards × 1 "Not connected" pill each (Lightspeed, Square, Clover, eBay)
      expect(notConnected.length).toBe(4);
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

  it('connects Square from the visible provider form', async () => {
    setupAllDisconnected();
    (apiMock.connectSquare as jest.Mock).mockResolvedValue({
      message: 'connected',
      merchant_id: 'merchant-1',
      location_id: null,
    });
    const { getByText, getByPlaceholderText } = render(<SettingsScreen />);

    await waitFor(() => expect(getByText('Connect Square')).toBeTruthy());
    fireEvent.press(getByText('Connect Square'));
    fireEvent.changeText(getByPlaceholderText('Paste access token'), 'token-123');
    fireEvent.changeText(getByPlaceholderText('Merchant ID'), 'merchant-1');
    fireEvent.press(getByText('Connect'));

    await waitFor(() => {
      expect(apiMock.connectSquare).toHaveBeenCalledWith({
        access_token: 'token-123',
        merchant_id: 'merchant-1',
        location_id: undefined,
      });
      expect(Alert.alert).toHaveBeenCalledWith(
        'Connected',
        'Square is connected. You can sync inventory now.',
      );
    });
  });

  it('requires explicit credentials before permanently deleting an account', async () => {
    setupAllDisconnected();
    (apiMock.deleteAccount as jest.Mock).mockResolvedValue({ message: 'deleted' });
    const screen = render(<SettingsScreen />);

    await waitFor(() => expect(screen.getByText('Delete Account')).toBeTruthy());
    fireEvent.press(screen.getByText('Delete Account'));
    fireEvent.changeText(screen.getByLabelText('Account password'), 'TestPass123');
    fireEvent.changeText(screen.getByLabelText('Delete confirmation'), 'DELETE');
    fireEvent.press(screen.getByText('Delete Permanently'));

    await waitFor(() => {
      expect(apiMock.deleteAccount).toHaveBeenCalledWith('TestPass123');
    });
  });

  it('handles profile-photo permission, success, and upload failures', async () => {
    setupAllDisconnected();
    const picker = ImagePicker as jest.Mocked<typeof ImagePicker>;
    const screen = render(<SettingsScreen />);
    await screen.findByTestId('settings-content');

    fireEvent.press(screen.getByLabelText('Change profile photo'));
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'Permission required',
        'Allow photo library access to update your profile photo.',
      ),
    );

    picker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ status: 'granted' } as any);
    picker.launchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ base64: 'avatar-bytes' }],
    } as any);
    (apiMock.updateProfile as jest.Mock).mockResolvedValueOnce({});
    fireEvent.press(screen.getByLabelText('Change profile photo'));
    await waitFor(() =>
      expect(apiMock.updateProfile).toHaveBeenCalledWith(
        'Test Shop',
        'data:image/jpeg;base64,avatar-bytes',
      ),
    );
    expect(mockRefreshUser).toHaveBeenCalled();

    picker.launchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ base64: 'bad-avatar' }],
    } as any);
    (apiMock.updateProfile as jest.Mock).mockRejectedValueOnce(new Error('image too large'));
    fireEvent.press(screen.getByLabelText('Change profile photo'));
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith('Photo update failed', 'image too large'),
    );
  });

  it('opens the Lightspeed OAuth flow and reports launch failures', async () => {
    setupAllDisconnected();
    (apiMock.getLightspeedConnectUrl as jest.Mock).mockResolvedValueOnce({
      authorization_url: 'https://lightspeed.example/authorize',
    });
    const screen = render(<SettingsScreen />);
    await screen.findByText('Connect Lightspeed');
    fireEvent.press(screen.getByText('Connect Lightspeed'));
    await waitFor(() =>
      expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith(
        'https://lightspeed.example/authorize',
        'vendora://settings',
      ),
    );
    expect(backgroundSync.registerBackgroundSync).toHaveBeenCalled();
    await waitFor(() => expect(apiMock.getLightspeedStatus).toHaveBeenCalledTimes(2));

    (apiMock.getLightspeedConnectUrl as jest.Mock).mockRejectedValueOnce(new Error('OAuth down'));
    fireEvent.press(screen.getByText('Connect Lightspeed'));
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith('Lightspeed unavailable', 'OAuth down'),
    );
  });

  it('continues the Lightspeed flow when background registration is unavailable', async () => {
    setupAllDisconnected();
    (apiMock.getLightspeedConnectUrl as jest.Mock).mockResolvedValueOnce({
      authorization_url: 'https://lightspeed.example/authorize',
    });
    (backgroundSync.registerBackgroundSync as jest.Mock).mockRejectedValueOnce(
      new Error('native unavailable'),
    );
    const screen = render(<SettingsScreen />);
    await screen.findByText('Connect Lightspeed');
    fireEvent.press(screen.getByText('Connect Lightspeed'));
    await waitFor(() => expect(apiMock.getLightspeedStatus).toHaveBeenCalledTimes(2));
    expect(Alert.alert).not.toHaveBeenCalledWith(
      'Lightspeed unavailable',
      expect.any(String),
    );
  });

  it('syncs each connected provider and routes to the sync center', async () => {
    (apiMock.getLightspeedStatus as jest.Mock).mockResolvedValue({
      ...NOT_CONNECTED_LS,
      connected: true,
    });
    (apiMock.getSquareStatus as jest.Mock).mockResolvedValue({ ...NOT_CONNECTED_SQ, connected: true });
    (apiMock.getCloverStatus as jest.Mock).mockResolvedValue({ ...NOT_CONNECTED_CV, connected: true });
    (apiMock.getProviderHealth as jest.Mock).mockResolvedValue({
      providers: [
        { last_run_status: 'completed', open_issues_count: 1 },
        { last_run_status: 'partial', open_issues_count: 2 },
      ],
    });
    (apiMock.triggerLightspeedSync as jest.Mock).mockResolvedValue({});
    (apiMock.triggerSquareSync as jest.Mock).mockResolvedValue({});
    (apiMock.triggerCloverSync as jest.Mock).mockResolvedValue({});
    const screen = render(<SettingsScreen />);
    await waitFor(() => expect(screen.getAllByText('Sync Now')).toHaveLength(3));
    const buttons = screen.getAllByText('Sync Now');
    fireEvent.press(buttons[0]);
    fireEvent.press(buttons[1]);
    fireEvent.press(buttons[2]);
    await waitFor(() => {
      expect(apiMock.triggerLightspeedSync).toHaveBeenCalled();
      expect(apiMock.triggerSquareSync).toHaveBeenCalled();
      expect(apiMock.triggerCloverSync).toHaveBeenCalled();
      expect(apiMock.getLightspeedStatus).toHaveBeenCalledTimes(4);
    });
    expect(mockPush).toHaveBeenCalledWith('/settings/sync-center');
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('reports provider sync failures', async () => {
    (apiMock.getLightspeedStatus as jest.Mock).mockResolvedValue({ ...NOT_CONNECTED_LS, connected: true });
    (apiMock.getSquareStatus as jest.Mock).mockResolvedValue(NOT_CONNECTED_SQ);
    (apiMock.getCloverStatus as jest.Mock).mockResolvedValue(NOT_CONNECTED_CV);
    (apiMock.getProviderHealth as jest.Mock).mockResolvedValue(EMPTY_HEALTH);
    (apiMock.triggerLightspeedSync as jest.Mock).mockRejectedValueOnce(new Error('sync down'));
    const screen = render(<SettingsScreen />);
    await screen.findByText('Sync Now');
    fireEvent.press(screen.getByText('Sync Now'));
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith('Lightspeed sync failed', 'sync down'),
    );
  });

  it('reports Square and Clover sync failures', async () => {
    (apiMock.getLightspeedStatus as jest.Mock).mockResolvedValue(NOT_CONNECTED_LS);
    (apiMock.getSquareStatus as jest.Mock).mockResolvedValue({ ...NOT_CONNECTED_SQ, connected: true });
    (apiMock.getCloverStatus as jest.Mock).mockResolvedValue({ ...NOT_CONNECTED_CV, connected: true });
    (apiMock.getProviderHealth as jest.Mock).mockResolvedValue(EMPTY_HEALTH);
    (apiMock.triggerSquareSync as jest.Mock).mockRejectedValueOnce(new Error('square down'));
    (apiMock.triggerCloverSync as jest.Mock).mockRejectedValueOnce(new Error('clover down'));
    const screen = render(<SettingsScreen />);
    await waitFor(() => expect(screen.getAllByText('Sync Now')).toHaveLength(2));
    const buttons = screen.getAllByText('Sync Now');
    fireEvent.press(buttons[0]);
    fireEvent.press(buttons[1]);
    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith('Square sync failed', 'square down');
      expect(Alert.alert).toHaveBeenCalledWith('Clover sync failed', 'clover down');
    });
  });

  it('validates and connects Clover credentials', async () => {
    setupAllDisconnected();
    (apiMock.connectClover as jest.Mock).mockResolvedValue({ message: 'connected' });
    const screen = render(<SettingsScreen />);
    await screen.findByText('Connect Clover');
    fireEvent.press(screen.getByText('Connect Clover'));
    fireEvent.press(screen.getByText('Connect'));
    expect(Alert.alert).toHaveBeenLastCalledWith('Missing token', 'Enter the provider access token.');
    fireEvent.changeText(screen.getByLabelText('Provider access token'), ' clover-token ');
    fireEvent.press(screen.getByText('Connect'));
    expect(Alert.alert).toHaveBeenLastCalledWith(
      'Missing merchant ID',
      'Clover requires a merchant ID.',
    );
    fireEvent.changeText(screen.getByLabelText('Merchant ID'), ' merchant-2 ');
    fireEvent.press(screen.getByText('Connect'));
    await waitFor(() =>
      expect(apiMock.connectClover).toHaveBeenCalledWith({
        access_token: 'clover-token',
        merchant_id: 'merchant-2',
      }),
    );
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'Connected',
        'Clover is connected. You can sync inventory now.',
      ),
    );
  });

  it('connects Square with location metadata and reports connection failures', async () => {
    setupAllDisconnected();
    (apiMock.connectSquare as jest.Mock).mockRejectedValueOnce(new Error('bad credentials'));
    const screen = render(<SettingsScreen />);
    await screen.findByText('Connect Square');
    fireEvent.press(screen.getByText('Connect Square'));
    fireEvent.changeText(screen.getByLabelText('Provider access token'), 'token');
    fireEvent.changeText(screen.getByLabelText('Merchant ID'), 'merchant');
    fireEvent.changeText(screen.getByLabelText('Location ID'), 'location');
    fireEvent.press(screen.getByText('Connect'));
    await waitFor(() =>
      expect(apiMock.connectSquare).toHaveBeenCalledWith({
        access_token: 'token',
        merchant_id: 'merchant',
        location_id: 'location',
      }),
    );
    expect(Alert.alert).toHaveBeenCalledWith('Connection failed', 'bad credentials');
    fireEvent.press(screen.getByText('Cancel'));
  });

  it('validates, cancels, and reports account deletion failures', async () => {
    setupAllDisconnected();
    const screen = render(<SettingsScreen />);
    await screen.findByText('Delete Account');
    fireEvent.press(screen.getByText('Delete Account'));
    const Modal = require('react-native').Modal;
    const deleteModal = screen
      .UNSAFE_getAllByType(Modal)
      .find((node) => node.props.visible && node.props.onRequestClose);
    fireEvent(deleteModal!, 'requestClose');

    fireEvent.press(screen.getByText('Delete Account'));
    fireEvent.press(screen.getByText('Delete Permanently'));
    expect(Alert.alert).toHaveBeenCalledWith(
      'Confirmation required',
      'Enter your password and type "DELETE" exactly.',
    );
    fireEvent.press(screen.getByText('Cancel'));

    fireEvent.press(screen.getByText('Delete Account'));
    fireEvent.changeText(screen.getByLabelText('Account password'), 'password');
    fireEvent.changeText(screen.getByLabelText('Delete confirmation'), 'DELETE');
    (apiMock.deleteAccount as jest.Mock).mockRejectedValueOnce(new Error('wrong password'));
    fireEvent.press(screen.getByText('Delete Permanently'));
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith('Account deletion failed', 'wrong password'),
    );
  });

  it('opens Sync Center and unregisters background sync on sign out', async () => {
    setupAllDisconnected();
    (backgroundSync.unregisterBackgroundSync as jest.Mock).mockRejectedValueOnce(
      new Error('native unavailable'),
    );
    const screen = render(<SettingsScreen />);
    await screen.findByText('Open Sync Center');
    fireEvent.press(screen.getByText('Open Sync Center'));
    fireEvent.press(screen.getByText('Sign Out'));
    expect(mockPush).toHaveBeenCalledWith('/settings/sync-center');
    expect(backgroundSync.unregisterBackgroundSync).toHaveBeenCalled();
    expect(mockSignOut).toHaveBeenCalled();
  });

  it('connects eBay via OAuth and reports launch failures', async () => {
    setupAllDisconnected();
    (apiMock.getEbayConnectUrl as jest.Mock).mockResolvedValueOnce({ authorization_url: 'https://ebay.test/oauth' });
    const screen = render(<SettingsScreen />);
    await screen.findByTestId('settings-content');
    fireEvent.press(screen.getByText('Connect eBay'));
    await waitFor(() => expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith('https://ebay.test/oauth', expect.anything()));

    (apiMock.getEbayConnectUrl as jest.Mock).mockRejectedValueOnce(new Error('nope'));
    fireEvent.press(screen.getByText('Connect eBay'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('eBay unavailable', 'nope'));
  });

  it('syncs eBay to the sync center and reports failures', async () => {
    setupAllDisconnected();
    (apiMock.getEbayStatus as jest.Mock).mockResolvedValue({ connected: true, account_id: 'seller', expires_at: null, last_synced_at: null });
    (apiMock.triggerEbaySync as jest.Mock).mockResolvedValueOnce({ status: 'completed' });
    const screen = render(<SettingsScreen />);
    await screen.findByTestId('settings-content');
    fireEvent.press(await screen.findByText('Sync Now')); // eBay is the only connected provider
    await waitFor(() => {
      expect(apiMock.triggerEbaySync).toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalledWith('/settings/sync-center');
    });

    (apiMock.triggerEbaySync as jest.Mock).mockRejectedValueOnce(new Error('sync down'));
    fireEvent.press(screen.getByText('Sync Now'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('eBay sync failed', 'sync down'));
  });

  it('disconnects eBay after confirmation and reports failures', async () => {
    setupAllDisconnected();
    (apiMock.getEbayStatus as jest.Mock).mockResolvedValue({ connected: true, account_id: 'seller', expires_at: null, last_synced_at: null });
    (apiMock.disconnectEbay as jest.Mock).mockResolvedValueOnce({ disconnected: true, links_retained: 0 });
    const screen = render(<SettingsScreen />);
    await screen.findByTestId('settings-content');
    (Alert.alert as jest.Mock).mockImplementation((_t, _m, buttons?: any[]) =>
      buttons?.find((b) => b.text === 'Disconnect')?.onPress?.(),
    );
    fireEvent.press(await screen.findByText('Disconnect')); // eBay is the only provider with a Disconnect action
    await waitFor(() => expect(apiMock.disconnectEbay).toHaveBeenCalled());
    // Failure path.
    (apiMock.disconnectEbay as jest.Mock).mockRejectedValueOnce(new Error('dc down'));
    fireEvent.press(screen.getByText('Disconnect'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Disconnect failed', 'dc down'));
  });

  it('saves invoice branding, validating hex and reporting failures', async () => {
    setupAllDisconnected();
    const screen = render(<SettingsScreen />);
    await screen.findByTestId('settings-content');
    // Pick a preset swatch color.
    fireEvent.press(screen.getAllByLabelText(/^Use color /)[0]);
    // Invalid hex is rejected before any request.
    fireEvent.changeText(screen.getByLabelText('Brand color hex'), 'nope');
    fireEvent.press(screen.getByText('Save Branding'));
    expect(Alert.alert).toHaveBeenLastCalledWith('Invalid color', expect.any(String));
    expect(apiMock.updateProfile).not.toHaveBeenCalled();
    // Valid hex saves.
    fireEvent.changeText(screen.getByLabelText('Brand color hex'), '#123ABC');
    (apiMock.updateProfile as jest.Mock).mockResolvedValueOnce({});
    fireEvent.press(screen.getByText('Save Branding'));
    await waitFor(() =>
      expect(apiMock.updateProfile).toHaveBeenCalledWith(
        expect.objectContaining({ invoice_accent_color: '#123ABC' }),
      ),
    );
    // Save failure surfaces an alert.
    (apiMock.updateProfile as jest.Mock).mockRejectedValueOnce(new Error('save down'));
    fireEvent.press(screen.getByText('Save Branding'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Save failed', 'save down'));
  });
});
