import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import SyncCenterScreen from '../app/(tabs)/settings/sync-center';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

jest.mock('../services/api', () => ({
  listSyncRuns: jest.fn(),
  listReconciliationIssues: jest.fn(),
  getLightspeedStatus: jest.fn(),
  getSquareStatus: jest.fn(),
  getCloverStatus: jest.fn(),
  getEbayStatus: jest.fn(),
  triggerLightspeedSync: jest.fn(),
  triggerSquareSync: jest.fn(),
  triggerCloverSync: jest.fn(),
  triggerEbaySync: jest.fn(),
}));

const DISCONNECTED = { connected: false, last_synced_at: null };

beforeEach(() => {
  jest.clearAllMocks();
  (apiMock.getLightspeedStatus as jest.Mock).mockResolvedValue({ connected: true, last_synced_at: new Date().toISOString() });
  (apiMock.getSquareStatus as jest.Mock).mockResolvedValue(DISCONNECTED);
  (apiMock.getCloverStatus as jest.Mock).mockResolvedValue(DISCONNECTED);
  (apiMock.getEbayStatus as jest.Mock).mockResolvedValue(DISCONNECTED);
  (apiMock.triggerLightspeedSync as jest.Mock).mockResolvedValue({ status: 'completed' });
  (apiMock.listReconciliationIssues as jest.Mock).mockResolvedValue([]);
  (apiMock.listSyncRuns as jest.Mock).mockResolvedValue([
    { id: 'run-1', provider: 'lightspeed', status: 'completed', started_at: '2026-04-25T12:00:00Z', items_imported: 20, items_updated: 5, errors_count: 0 },
  ]);
});

describe('SyncCenterScreen', () => {
  it('renders the integrations list, connection state, and sync history', async () => {
    const screen = render(<SyncCenterScreen />);
    await waitFor(() => {
      expect(screen.getByText('Integrations')).toBeTruthy();
      expect(screen.getByText('Lightspeed')).toBeTruthy();
      expect(screen.getByText('eBay')).toBeTruthy();
      expect(screen.getByText('Connected')).toBeTruthy();
      expect(screen.getAllByText('Not connected').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Sync History')).toBeTruthy();
      expect(screen.getByText('Lightspeed Sync')).toBeTruthy();
      expect(screen.getByText('Success')).toBeTruthy();
    }, { timeout: 3000 });
  });

  it('syncs all connected providers when "Sync All Now" is pressed', async () => {
    const screen = render(<SyncCenterScreen />);
    await screen.findByText('Sync All Now');
    fireEvent.press(screen.getByText('Sync All Now'));
    await waitFor(() => expect(apiMock.triggerLightspeedSync).toHaveBeenCalled());
    // Square/Clover/eBay are disconnected, so they are not synced.
    expect(apiMock.triggerSquareSync).not.toHaveBeenCalled();
  });

  it('routes to Settings when tapping a disconnected provider', async () => {
    const screen = render(<SyncCenterScreen />);
    await screen.findByText('Square');
    fireEvent.press(screen.getByText('Square'));
    expect(mockPush).toHaveBeenCalledWith('/settings');
  });
});
