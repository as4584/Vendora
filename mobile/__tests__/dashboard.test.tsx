/**
 * Dashboard screen regression tests
 *
 * Covers:
 *  1. Loading state is shown on mount
 *  2. Loading state exits on API success
 *  3. Loading state exits on API failure
 *  4. Export downloads a real CSV file
 *  5. Sync sends seeded demo users to Sync Center instead of failing
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('../__mocks__/async-storage'),
);

const mockPush = jest.fn();
const mockReplace = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

jest.mock('../services/api', () => ({
  getDashboard: jest.fn(),
  getProviderHealth: jest.fn(),
  listItems: jest.fn(),
  exportInventoryCSV: jest.fn(),
  getLightspeedStatus: jest.fn(),
  getSquareStatus: jest.fn(),
  getCloverStatus: jest.fn(),
  triggerLightspeedSync: jest.fn(),
  triggerSquareSync: jest.fn(),
  triggerCloverSync: jest.fn(),
}));

jest.mock('../utils/fileActions', () => ({
  downloadTextFile: jest.fn(),
}));

import React from 'react';
import { Alert } from 'react-native';
import { render, waitFor, act, fireEvent } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import * as fileActionsMock from '../utils/fileActions';
import DashboardScreen from '../app/(tabs)/dashboard';

const originalConsoleError = console.error;

const MOCK_DASHBOARD: apiMock.Dashboard = {
  revenue_today: '150.00',
  revenue_week: '500.00',
  revenue_month: '1500.00',
  net_profit_today: '50.00',
  net_profit_week: '200.00',
  net_profit_month: '600.00',
  net_profit_all_time: '300.00',
  total_inventory_value: '600.00',
  total_expected_value: '1200.00',
  potential_profit: '600.00',
  total_items: 5,
  items_in_stock: 3,
  items_listed: 1,
  items_sold: 1,
  total_transactions: 2,
  total_refunds: 0,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setupMocks({
  dashSuccess = true,
}: { dashSuccess?: boolean } = {}) {
  const getDashboard = apiMock.getDashboard as jest.Mock;
  const getProviderHealth = apiMock.getProviderHealth as jest.Mock;
  const listItems = apiMock.listItems as jest.Mock;
  const getLightspeedStatus = apiMock.getLightspeedStatus as jest.Mock;
  const getSquareStatus = apiMock.getSquareStatus as jest.Mock;
  const getCloverStatus = apiMock.getCloverStatus as jest.Mock;

  if (dashSuccess) {
    getDashboard.mockResolvedValue(MOCK_DASHBOARD);
  } else {
    getDashboard.mockRejectedValue(new Error('Network error'));
  }
  getProviderHealth.mockResolvedValue({ providers: [] });
  listItems.mockResolvedValue({ items: [], total: 0, page: 1, per_page: 100, pages: 0 });
  getLightspeedStatus.mockResolvedValue({ connected: false });
  getSquareStatus.mockResolvedValue({ connected: false });
  getCloverStatus.mockResolvedValue({ connected: false });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.includes('not wrapped in act')) {
      return;
    }
    originalConsoleError(message as any, ...args);
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('DashboardScreen', () => {
  it('shows loading indicator on mount', () => {
    setupMocks();
    const { getByTestId } = render(<DashboardScreen />);
    expect(getByTestId('dashboard-loading')).toBeTruthy();
  });

  it('exits loading state and renders KPI data on success', async () => {
    const dashboard = deferred<apiMock.Dashboard>();
    const providerHealth = deferred<{ providers: apiMock.ProviderHealthEntry[] }>();
    const inventory = deferred<apiMock.PaginatedItems>();
    (apiMock.getDashboard as jest.Mock).mockReturnValue(dashboard.promise);
    (apiMock.getProviderHealth as jest.Mock).mockReturnValue(providerHealth.promise);
    (apiMock.listItems as jest.Mock).mockReturnValue(inventory.promise);

    const screen = render(<DashboardScreen />);

    expect(screen.getByTestId('dashboard-loading')).toBeTruthy();

    await act(async () => {
      dashboard.resolve(MOCK_DASHBOARD);
      providerHealth.resolve({ providers: [] });
      inventory.resolve({ items: [], total: 0, page: 1, per_page: 100, pages: 0 });
      await Promise.all([dashboard.promise, providerHealth.promise, inventory.promise]);
      await Promise.resolve();
    });

    expect(screen.getByTestId('dashboard-content')).toBeTruthy();
  });

  it('exits loading state and shows error view on API failure', async () => {
    const dashboard = deferred<apiMock.Dashboard>();
    const providerHealth = deferred<{ providers: apiMock.ProviderHealthEntry[] }>();
    const inventory = deferred<apiMock.PaginatedItems>();
    (apiMock.getDashboard as jest.Mock).mockReturnValue(dashboard.promise);
    (apiMock.getProviderHealth as jest.Mock).mockReturnValue(providerHealth.promise);
    (apiMock.listItems as jest.Mock).mockReturnValue(inventory.promise);

    const screen = render(<DashboardScreen />);

    await act(async () => {
      dashboard.reject(new Error('Network error'));
      providerHealth.resolve({ providers: [] });
      inventory.resolve({ items: [], total: 0, page: 1, per_page: 100, pages: 0 });
      await Promise.all([
        dashboard.promise.catch(() => null),
        providerHealth.promise,
        inventory.promise,
      ]);
      await Promise.resolve();
    });

    expect(screen.getByText('Could not load dashboard.')).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  it('downloads a CSV when Export is pressed', async () => {
    const dashboard = deferred<apiMock.Dashboard>();
    const providerHealth = deferred<{ providers: apiMock.ProviderHealthEntry[] }>();
    const inventory = deferred<apiMock.PaginatedItems>();
    (apiMock.getDashboard as jest.Mock).mockReturnValue(dashboard.promise);
    (apiMock.getProviderHealth as jest.Mock).mockReturnValue(providerHealth.promise);
    (apiMock.listItems as jest.Mock).mockReturnValue(inventory.promise);
    (apiMock.exportInventoryCSV as jest.Mock).mockResolvedValue('id,name\n1,Jordan');

    const screen = render(<DashboardScreen />);

    await act(async () => {
      dashboard.resolve(MOCK_DASHBOARD);
      providerHealth.resolve({ providers: [] });
      inventory.resolve({ items: [], total: 0, page: 1, per_page: 100, pages: 0 });
      await Promise.all([dashboard.promise, providerHealth.promise, inventory.promise]);
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Export'));
    });

    expect(apiMock.exportInventoryCSV).toHaveBeenCalled();
    expect(fileActionsMock.downloadTextFile).toHaveBeenCalledWith('id,name\n1,Jordan', 'vendora-inventory.csv');
  });

  it('routes to Sync Center when no providers are connected', async () => {
    setupMocks();
    const screen = render(<DashboardScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-content')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Sync'));
    });

    expect(mockPush).toHaveBeenCalledWith('/settings/sync-center');
  });
});
