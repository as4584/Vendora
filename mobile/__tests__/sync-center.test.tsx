import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
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
  listOutboxJobs: jest.fn(async () => []),
  retryOutboxJob: jest.fn(),
  listEbayPayouts: jest.fn(async () => []),
  listEbayFees: jest.fn(async () => []),
  syncEbayFinances: jest.fn(),
  retrySyncRun: jest.fn(),
  updateReconciliationIssue: jest.fn(),
}));

const DISCONNECTED = { connected: false, last_synced_at: null };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
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
  it('shows failing marketplace updates and retries them', async () => {
    const job = {
      id: 'job-1', provider: 'ebay', action: 'sync_quantity', inventory_item_id: 'i1', item_name: 'Jordan 1',
      status: 'failed', attempts: 6, max_attempts: 6, next_attempt_at: null, last_error: 'eBay unavailable',
      completed_at: null, created_at: '2026-11-02T00:00:00Z',
    };
    (apiMock.listOutboxJobs as jest.Mock).mockResolvedValue([job, { ...job, id: 'job-2', status: 'pending', attempts: 2, item_name: 'Dunk', last_error: 'boom', provider: 'stockx', action: 'delete_listing' },
      { ...job, id: 'job-3', status: 'pending', attempts: 1, item_name: null, last_error: null, provider: 'other_one', action: 'odd_thing' }]);
    (apiMock.retryOutboxJob as jest.Mock).mockResolvedValueOnce({ ...job, status: 'dead' }).mockRejectedValueOnce(new Error('offline'));
    const screen = render(<SyncCenterScreen />);
    expect(await screen.findByText('Marketplace Updates Failing')).toBeTruthy();
    expect(screen.getByText('eBay · Update quantity · Jordan 1')).toBeTruthy();
    expect(screen.getByText('StockX · Remove sold-out ask · Dunk')).toBeTruthy();
    expect(screen.getByText('Other_one · odd thing · Item')).toBeTruthy();
    expect(screen.getByText(/stopped retrying/)).toBeTruthy();
    expect(screen.getByText(/retrying, attempt 2 of 6/)).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('Retry eBay update for Jordan 1')); });
    expect(apiMock.retryOutboxJob).toHaveBeenCalledWith('job-1');
    expect(Alert.alert).toHaveBeenCalledWith('Still failing', 'eBay unavailable');
    await act(async () => { fireEvent.press(screen.getByLabelText('Retry eBay update for Jordan 1')); });
    expect(Alert.alert).toHaveBeenCalledWith('Retry failed', 'offline');
    (apiMock.retryOutboxJob as jest.Mock).mockResolvedValueOnce({ ...job, provider: 'stockx', status: 'pending', last_error: null });
    await act(async () => { fireEvent.press(screen.getByLabelText('Retry StockX update for Dunk')); });
    expect(Alert.alert).toHaveBeenCalledWith('Still failing', 'StockX did not accept the change yet.');
    (apiMock.listOutboxJobs as jest.Mock).mockResolvedValue([]);
  });

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

  it('syncs a single connected provider (success) and reports its failure', async () => {
    const screen = render(<SyncCenterScreen />);
    await screen.findByText('Lightspeed');
    // Success path reloads history.
    fireEvent.press(screen.getByText('Lightspeed'));
    await waitFor(() => expect(apiMock.triggerLightspeedSync).toHaveBeenCalled());
    await waitFor(() => expect(apiMock.listSyncRuns).toHaveBeenCalledTimes(2));
    // Failure path.
    (apiMock.triggerLightspeedSync as jest.Mock).mockRejectedValueOnce(new Error('ls down'));
    fireEvent.press(screen.getByText('Lightspeed'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Sync failed', 'ls down'));
  });

  it('formats last-sync times across minute, hour, and day ranges', async () => {
    const now = Date.now();
    (apiMock.getLightspeedStatus as jest.Mock).mockResolvedValue({ connected: true, last_synced_at: new Date(now - 5 * 60000).toISOString() });
    (apiMock.getSquareStatus as jest.Mock).mockResolvedValue({ connected: true, last_synced_at: new Date(now - 2 * 3600000).toISOString() });
    (apiMock.getCloverStatus as jest.Mock).mockResolvedValue({ connected: true, last_synced_at: new Date(now - 50 * 3600000).toISOString() });
    const screen = render(<SyncCenterScreen />);
    await screen.findByText('Integrations');
    expect(screen.getByText('Last sync 5m ago')).toBeTruthy();
    expect(screen.getByText('Last sync 2h ago')).toBeTruthy();
    expect(screen.getByText('Last sync 2d ago')).toBeTruthy();
  });

  it('degrades gracefully when every request fails', async () => {
    (apiMock.getLightspeedStatus as jest.Mock).mockRejectedValue(new Error('x'));
    (apiMock.getSquareStatus as jest.Mock).mockRejectedValue(new Error('x'));
    (apiMock.getCloverStatus as jest.Mock).mockRejectedValue(new Error('x'));
    (apiMock.getEbayStatus as jest.Mock).mockRejectedValue(new Error('x'));
    (apiMock.listSyncRuns as jest.Mock).mockRejectedValue(new Error('x'));
    (apiMock.listReconciliationIssues as jest.Mock).mockRejectedValue(new Error('x'));
    const screen = render(<SyncCenterScreen />);
    await screen.findByText('Integrations');
    expect(screen.getAllByText('Not connected').length).toBe(4);
  });

  it('reports a partial result from Sync All Now', async () => {
    (apiMock.getSquareStatus as jest.Mock).mockResolvedValue({ connected: true, last_synced_at: null });
    (apiMock.triggerSquareSync as jest.Mock).mockRejectedValue(new Error('sq down'));
    const screen = render(<SyncCenterScreen />);
    await screen.findByText('Sync All Now');
    fireEvent.press(screen.getByText('Sync All Now'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Partial sync', expect.stringContaining('of 2 providers synced')));
  });

  it('warns when there is nothing to sync', async () => {
    (apiMock.getLightspeedStatus as jest.Mock).mockResolvedValue(DISCONNECTED);
    const screen = render(<SyncCenterScreen />);
    await screen.findByText('Sync All Now');
    fireEvent.press(screen.getByText('Sync All Now'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Nothing to sync', expect.any(String)));
  });

  it('refreshes via pull-to-refresh', async () => {
    const screen = render(<SyncCenterScreen />);
    await screen.findByText('Integrations');
    const control = screen.UNSAFE_getByType(require('react-native').RefreshControl);
    await act(async () => control.props.onRefresh());
    await waitFor(() => expect(apiMock.listSyncRuns).toHaveBeenCalledTimes(2));
  });

  it('renders history status variants, reconciliation issues, and the view-all toggle', async () => {
    (apiMock.listSyncRuns as jest.Mock).mockResolvedValue([
      { id: 'r1', provider: 'lightspeed', status: 'completed', started_at: '2026-04-25T12:00:00Z', items_imported: 1, items_updated: 0 },
      { id: 'r2', provider: 'square', status: 'partial', started_at: '2026-04-25T12:00:00Z', items_imported: 1, items_updated: 0 },
      { id: 'r3', provider: 'clover', status: 'running', started_at: '2026-04-25T12:00:00Z', items_imported: 0, items_updated: 0 },
      { id: 'r4', provider: 'ebay', status: 'failed', started_at: '2026-04-25T12:00:00Z', items_imported: 0, items_updated: 0 },
      { id: 'r5', provider: 'lightspeed', status: 'completed', started_at: '2026-04-25T12:00:00Z', items_imported: 2, items_updated: 1 },
    ]);
    (apiMock.listReconciliationIssues as jest.Mock).mockResolvedValue([
      { id: 'i1', provider: 'square', issue_type: 'missing_item', external_id: 'SQ-1', status: 'open', detected_at: '2026-04-25T12:03:00Z' },
    ]);
    const screen = render(<SyncCenterScreen />);
    await screen.findByText('Sync History');
    expect(screen.getByText('Partial')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Reconciliation Issues')).toBeTruthy();
    // 5 runs > 4 → View All History appears; toggling shows "Show less".
    fireEvent.press(screen.getByText('View All History'));
    expect(screen.getByText('Show less')).toBeTruthy();
  });

  it('retries a failed sync run and reports remaining errors or failure', async () => {
    (apiMock.listSyncRuns as jest.Mock).mockResolvedValue([
      { id: 'run-f', provider: 'square', status: 'failed', started_at: '2026-04-25T12:00:00Z', items_imported: 0, items_updated: 0, errors_count: 3 },
    ]);
    (apiMock.retrySyncRun as jest.Mock)
      .mockResolvedValueOnce({ errors_count: 2 })
      .mockResolvedValueOnce({ errors_count: 0 })
      .mockRejectedValueOnce(new Error('down'));
    const screen = render(<SyncCenterScreen />);
    const retry = await screen.findByLabelText('Retry Square sync');
    await act(async () => { fireEvent.press(retry); });
    expect(apiMock.retrySyncRun).toHaveBeenCalledWith('run-f');
    expect(Alert.alert).toHaveBeenCalledWith('Retried with errors', '2 items still failed.');
    await act(async () => { fireEvent.press(screen.getByLabelText('Retry Square sync')); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Retry Square sync')); });
    expect(Alert.alert).toHaveBeenCalledWith('Retry failed', 'down');
  });

  it('resolves and dismisses open reconciliation issues', async () => {
    (apiMock.listReconciliationIssues as jest.Mock).mockResolvedValue([
      { id: 'iss-1', provider: 'clover', issue_type: 'stock_drift', status: 'open', external_id: 'X1', detected_at: '2026-04-25T12:00:00Z' },
      { id: 'iss-2', provider: 'square', issue_type: 'missing', status: 'resolved', external_id: null, detected_at: '2026-04-25T12:00:00Z' },
    ]);
    (apiMock.updateReconciliationIssue as jest.Mock).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('nope'));
    const screen = render(<SyncCenterScreen />);
    await screen.findByText('Reconciliation Issues');
    await act(async () => { fireEvent.press(screen.getByLabelText('Mark Clover issue resolved')); });
    expect(apiMock.updateReconciliationIssue).toHaveBeenCalledWith('iss-1', { status: 'resolved' });
    await act(async () => { fireEvent.press(screen.getByLabelText('Dismiss Clover issue')); });
    expect(apiMock.updateReconciliationIssue).toHaveBeenCalledWith('iss-1', { status: 'dismissed' });
    expect(Alert.alert).toHaveBeenCalledWith('Update failed', 'nope');
    expect(screen.getByText('RESOLVED')).toBeTruthy();
  });
});
