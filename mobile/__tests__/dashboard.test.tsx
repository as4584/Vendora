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

import React from 'react';
import { Alert } from 'react-native';
import { render, waitFor, act, fireEvent } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import * as fileActionsMock from '../utils/fileActions';
import DashboardScreen from '../app/(tabs)/dashboard';

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
  getAdvancedAnalytics: jest.fn(),
  listItems: jest.fn(),
  exportInventoryCSV: jest.fn(),
  exportInventoryWarehouseCSV: jest.fn(),
  getLightspeedStatus: jest.fn(),
  getSquareStatus: jest.fn(),
  getCloverStatus: jest.fn(),
  triggerLightspeedSync: jest.fn(),
  triggerSquareSync: jest.fn(),
  triggerCloverSync: jest.fn(),
}));

jest.mock('../context/auth', () => ({
  useAuth: () => ({ user: { business_name: 'Alex Store' } }),
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('../utils/fileActions', () => ({
  downloadTextFile: jest.fn(),
}));

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

const MOCK_ANALYTICS: apiMock.AdvancedAnalytics = {
  period_days: 30,
  revenue: '1500.00',
  net: '600.00',
  average_order_value: '75.00',
  sell_through_rate: '0.4',
  daily: Array.from({ length: 14 }, (_, i) => ({
    date: `2026-06-${String(i + 1).padStart(2, '0')}`,
    revenue: String(100 + i * 5),
    net: String(40 + i * 2),
    transactions: 1,
  })),
  categories: [],
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
  const getAdvancedAnalytics = apiMock.getAdvancedAnalytics as jest.Mock;
  const listItems = apiMock.listItems as jest.Mock;
  const getLightspeedStatus = apiMock.getLightspeedStatus as jest.Mock;
  const getSquareStatus = apiMock.getSquareStatus as jest.Mock;
  const getCloverStatus = apiMock.getCloverStatus as jest.Mock;

  if (dashSuccess) {
    getDashboard.mockResolvedValue(MOCK_DASHBOARD);
  } else {
    getDashboard.mockRejectedValue(new Error('Network error'));
  }
  getAdvancedAnalytics.mockResolvedValue(MOCK_ANALYTICS);
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
    const analytics = deferred<apiMock.AdvancedAnalytics>();
    const inventory = deferred<apiMock.PaginatedItems>();
    (apiMock.getDashboard as jest.Mock).mockReturnValue(dashboard.promise);
    (apiMock.getAdvancedAnalytics as jest.Mock).mockReturnValue(analytics.promise);
    (apiMock.listItems as jest.Mock).mockReturnValue(inventory.promise);

    const screen = render(<DashboardScreen />);

    expect(screen.getByTestId('dashboard-loading')).toBeTruthy();

    await act(async () => {
      dashboard.resolve(MOCK_DASHBOARD);
      analytics.resolve(MOCK_ANALYTICS);
      inventory.resolve({ items: [], total: 0, page: 1, per_page: 100, pages: 0 });
      await Promise.all([dashboard.promise, analytics.promise, inventory.promise]);
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId('dashboard-content')).toBeTruthy());
  });

  it('exits loading state and shows error view on API failure', async () => {
    const dashboard = deferred<apiMock.Dashboard>();
    const analytics = deferred<apiMock.AdvancedAnalytics>();
    const inventory = deferred<apiMock.PaginatedItems>();
    (apiMock.getDashboard as jest.Mock).mockReturnValue(dashboard.promise);
    (apiMock.getAdvancedAnalytics as jest.Mock).mockReturnValue(analytics.promise);
    (apiMock.listItems as jest.Mock).mockReturnValue(inventory.promise);

    const screen = render(<DashboardScreen />);

    await act(async () => {
      dashboard.reject(new Error('Network error'));
      analytics.resolve(MOCK_ANALYTICS);
      inventory.resolve({ items: [], total: 0, page: 1, per_page: 100, pages: 0 });
      await Promise.all([
        dashboard.promise.catch(() => null),
        analytics.promise,
        inventory.promise,
      ]);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText('Could not load dashboard.')).toBeTruthy();
      expect(screen.getByText('Retry')).toBeTruthy();
    });
  });

  it('keeps the dashboard usable when optional requests fail', async () => {
    setupMocks();
    (apiMock.getAdvancedAnalytics as jest.Mock).mockRejectedValue(new Error('analytics unavailable'));
    (apiMock.listItems as jest.Mock).mockRejectedValue(new Error('inventory unavailable'));

    const screen = render(<DashboardScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-content')).toBeTruthy();
      expect(screen.queryByText('Could not load dashboard.')).toBeNull();
    });
  });

  it('downloads a warehouse CSV when Export is pressed', async () => {
    const dashboard = deferred<apiMock.Dashboard>();
    const analytics = deferred<apiMock.AdvancedAnalytics>();
    const inventory = deferred<apiMock.PaginatedItems>();
    (apiMock.getDashboard as jest.Mock).mockReturnValue(dashboard.promise);
    (apiMock.getAdvancedAnalytics as jest.Mock).mockReturnValue(analytics.promise);
    (apiMock.listItems as jest.Mock).mockReturnValue(inventory.promise);
    (apiMock.exportInventoryWarehouseCSV as jest.Mock).mockResolvedValue('Product Name,,\nJordan,,');

    const screen = render(<DashboardScreen />);

    await act(async () => {
      dashboard.resolve(MOCK_DASHBOARD);
      analytics.resolve(MOCK_ANALYTICS);
      inventory.resolve({ items: [], total: 0, page: 1, per_page: 100, pages: 0 });
      await Promise.all([dashboard.promise, analytics.promise, inventory.promise]);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText('Export CSV')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Export CSV'));
    });

    expect(apiMock.exportInventoryWarehouseCSV).toHaveBeenCalled();
    expect(fileActionsMock.downloadTextFile).toHaveBeenCalledWith(
      'Product Name,,\nJordan,,',
      'vendora-inventory-warehouse.csv',
    );
  });

  it('routes to Sync Center when no providers are connected', async () => {
    setupMocks();
    const screen = render(<DashboardScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-content')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Sync POS'));
    });

    expect(mockPush).toHaveBeenCalledWith('/settings/sync-center');
  });

  it('refreshes through the native refresh control and retries a failed load', async () => {
    setupMocks();
    const screen = render(<DashboardScreen />);
    await screen.findByTestId('dashboard-content');
    const RefreshControl = require('react-native').RefreshControl;
    const control = screen.UNSAFE_getByType(RefreshControl);
    await act(async () => control.props.onRefresh());
    await waitFor(() => expect(apiMock.getDashboard).toHaveBeenCalledTimes(2));

    (apiMock.getDashboard as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    await act(async () => control.props.onRefresh());
    await screen.findByTestId('dashboard-error');
    (apiMock.getDashboard as jest.Mock).mockResolvedValueOnce(MOCK_DASHBOARD);
    fireEvent.press(screen.getByText('Retry'));
    await screen.findByTestId('dashboard-content');
  });

  it('renders low-stock state derived from inventory', async () => {
    setupMocks();
    (apiMock.listItems as jest.Mock).mockResolvedValue({
      items: [
        { id: 'one', quantity: 1 },
        { id: 'two', quantity: 3 },
        { id: 'three', quantity: 0 },
        { id: 'four', quantity: 8 },
      ],
      total: 4,
      page: 1,
      per_page: 100,
      pages: 1,
    });
    const screen = render(<DashboardScreen />);
    await screen.findByTestId('dashboard-content');
    // qty 1 and 3 are low (>0 and <=3); 0 and 8 are not.
    expect(screen.getByText('Low Stock')).toBeTruthy();
    expect(screen.getByText('View items')).toBeTruthy();
    expect(screen.getByText('Business Overview')).toBeTruthy();
  });

  it('starts all connected syncs and reports partial failures', async () => {
    setupMocks();
    (apiMock.getLightspeedStatus as jest.Mock).mockResolvedValue({ connected: true });
    (apiMock.getSquareStatus as jest.Mock).mockResolvedValue({ connected: true });
    (apiMock.getCloverStatus as jest.Mock).mockResolvedValue({ connected: true });
    (apiMock.triggerLightspeedSync as jest.Mock).mockResolvedValue({ status: 'started' });
    (apiMock.triggerSquareSync as jest.Mock).mockRejectedValue(new Error('square offline'));
    (apiMock.triggerCloverSync as jest.Mock).mockResolvedValue({ status: 'started' });
    const screen = render(<DashboardScreen />);
    await screen.findByTestId('dashboard-content');
    fireEvent.press(screen.getByText('Sync POS'));
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'Partial sync',
        '2 provider syncs started; 1 could not be started.',
      ),
    );
    expect(apiMock.triggerLightspeedSync).toHaveBeenCalled();
    expect(apiMock.triggerSquareSync).toHaveBeenCalled();
    expect(apiMock.triggerCloverSync).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/settings/sync-center');
  });

  it('reports export and provider-status failures', async () => {
    setupMocks();
    (apiMock.exportInventoryWarehouseCSV as jest.Mock).mockRejectedValueOnce(
      new Error('export unavailable'),
    );
    const screen = render(<DashboardScreen />);
    await screen.findByTestId('dashboard-content');
    fireEvent.press(screen.getByText('Export CSV'));
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith('Export failed', 'export unavailable'),
    );

    (apiMock.getLightspeedStatus as jest.Mock).mockRejectedValueOnce(new Error('sync unavailable'));
    fireEvent.press(screen.getByText('Sync POS'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Sync failed', 'sync unavailable'));
  });

  it('routes quick-action navigation', async () => {
    setupMocks();
    const screen = render(<DashboardScreen />);
    await screen.findByTestId('dashboard-content');
    fireEvent.press(screen.getByText('Quick Sale'));
    fireEvent.press(screen.getByText('Add Stock'));
    fireEvent.press(screen.getByText('Scan SKU'));
    expect(mockPush.mock.calls).toEqual(
      expect.arrayContaining([
        ['/inventory/sale'],
        ['/inventory/add'],
      ]),
    );
  });
});
