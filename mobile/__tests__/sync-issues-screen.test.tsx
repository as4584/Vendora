import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import SyncIssuesScreen from '../app/sync-issues';
import { SyncStatusPill } from '../components/SyncStatusPill';
import * as offline from '../services/offline';

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockDismiss = jest.fn();
let mockNet = { online: true, pending: 0, failed: 0, lastSync: null as string | null, dismissFailed: mockDismiss };

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
  useFocusEffect: (cb: () => void | (() => void)) => { const R = require('react'); R.useEffect(cb, []); },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../context/network', () => ({ useNetwork: () => mockNet }));
jest.mock('../services/offline', () => ({
  getFailedSyncs: jest.fn(async () => []),
  subscribeSync: jest.fn(() => () => undefined),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockNet = { online: true, pending: 0, failed: 0, lastSync: null, dismissFailed: mockDismiss };
});

describe('SyncStatusPill', () => {
  it('shows all synced and opens the sync screen', () => {
    const screen = render(<SyncStatusPill />);
    fireEvent.press(screen.getByText('All synced'));
    expect(mockPush).toHaveBeenCalledWith('/sync-issues');
  });

  it('shows offline backlog and rejected changes', () => {
    mockNet = { ...mockNet, online: false, pending: 2 };
    expect(render(<SyncStatusPill />).getByText('Offline · 2 changes saved on this phone')).toBeTruthy();
    mockNet = { ...mockNet, failed: 1 };
    expect(render(<SyncStatusPill />).getByText("1 change didn't sync · Review")).toBeTruthy();
  });
});

describe('SyncIssuesScreen', () => {
  it('says nothing failed when the list is empty', async () => {
    const screen = render(<SyncIssuesScreen />);
    expect(await screen.findByText(/None\. Everything you/)).toBeTruthy();
    expect(screen.getByText(/Not synced yet on this phone/)).toBeTruthy();
    fireEvent.press(screen.getByText('Done'));
    expect(mockBack).toHaveBeenCalled();
  });

  it('lists rejected changes with reasons and clears them', async () => {
    mockNet = { ...mockNet, failed: 1, lastSync: new Date().toISOString() };
    (offline.getFailedSyncs as jest.Mock).mockResolvedValue([
      { id: 'f1', kind: 'quick_sale', message: 'Item no longer exists', createdAt: new Date().toISOString(), failedAt: new Date().toISOString() },
    ]);
    const screen = render(<SyncIssuesScreen />);
    expect(await screen.findByText('Item no longer exists')).toBeTruthy();
    expect(screen.getByText(/^Sale · /)).toBeTruthy();
    expect(screen.getByText(/Last synced just now/)).toBeTruthy();
    fireEvent.press(screen.getByText('Clear list'));
    await waitFor(() => expect(mockDismiss).toHaveBeenCalled());
  });
});
