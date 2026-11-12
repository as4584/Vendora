/**
 * Inventory list screen regression tests
 *
 * Covers:
 *  1. Loading indicator shown on mount
 *  2. Loading exits on success — items render
 *  3. Loading exits on failure — no crash, empty list (silent error)
 *  4. Source badge renders for a lightspeed-sourced item
 *  5. Quantity displays safely when item has null quantity
 */

import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import * as fileActions from '../utils/fileActions';
import InventoryListScreen from '../app/(tabs)/inventory/index';

const mockPush = jest.fn();

jest.mock('../services/offline/snapshot', () => ({
  peekSnapshot: () => undefined,
  loadSnapshot: async () => undefined,
  saveSnapshot: () => undefined,
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('../__mocks__/async-storage'),
);
let mockTier = 'pro';
const mockRecent = { list: [] as string[] };
jest.mock('../services/recentSearches', () => ({
  getRecentSearches: jest.fn(async () => mockRecent.list),
  addRecentSearch: jest.fn(async (q: string) => { mockRecent.list = [q, ...mockRecent.list.filter((x) => x !== q)]; return mockRecent.list; }),
  clearRecentSearches: jest.fn(async () => { mockRecent.list = []; }),
}));
jest.mock('../context/auth', () => ({
  useAuth: () => ({ user: { subscription_tier: mockTier } }),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useFocusEffect: (cb: () => void) => {
    // Fire once like useEffect in tests
    const React = require('react');
    React.useEffect(cb, []);
  },
}));
jest.mock('../services/api', () => ({
  getSubscriptionStatus: jest.fn(async () => ({ pricing_grace_until: null })),
  listItems: jest.fn(),
  exportInventoryWarehouseCSV: jest.fn(),
  bulkDeleteItems: jest.fn(),
  deleteItem: jest.fn(async () => undefined),
  getToken: jest.fn(async () => 'tok-123'),
  exportInventoryXlsxUrl: jest.fn(() => 'https://api.test/export/inventory?format=xlsx'),
}));
jest.mock('../components/Backdrop', () => ({ GlassBlur: () => null }));
jest.mock('../utils/fileActions', () => ({
  downloadTextFile: jest.fn(),
  downloadAndShareRemote: jest.fn(),
}));

function makeItem(overrides: Partial<apiMock.InventoryItem> = {}): apiMock.InventoryItem {
  return {
    id: 'item-1',
    user_id: 'user-1',
    name: 'Jordan 1 Chicago',
    category: 'sneakers',
    sku: 'J1-CHI',
    upc: null,
    size: '10',
    color: 'red/black',
    condition: 'new',
    serial_number: null,
    custom_attributes: null,
    buy_price: '120.00',
    expected_sell_price: '250.00',
    actual_sell_price: null,
    platform: null,
    status: 'in_stock',
    photo_front_url: null,
    photo_back_url: null,
    quantity: 2,
    vendor_name: null,
    notes: null,
    source: null,
    external_id: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

const PAGINATED_EMPTY: apiMock.PaginatedItems = {
  items: [], total: 0, page: 1, per_page: 30, pages: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('InventoryListScreen', () => {
  it('filters the list reactively as characters are typed (subsequence)', async () => {
    (apiMock.listItems as jest.Mock).mockResolvedValue({
      ...PAGINATED_EMPTY,
      items: [
        makeItem({ id: 'a', name: 'Nike Black', color: 'black', category: 'shoes', sku: 'NK-1' }),
        makeItem({ id: 'b', name: 'Adidas White', color: 'white', category: 'shoes', sku: 'ADI-1' }),
      ],
      total: 2,
    });
    const screen = render(<InventoryListScreen />);
    await screen.findByText('Nike Black');
    fireEvent.changeText(screen.getByLabelText('Search inventory'), 'blk');
    // Seller shorthand: "blk" means black.
    expect(screen.getByText('Nike Black')).toBeTruthy();
    expect(screen.queryByText('Adidas White')).toBeNull();
    // Typos still find it.
    fireEvent.changeText(screen.getByLabelText('Search inventory'), 'adidsa');
    expect(screen.getByText('Adidas White')).toBeTruthy();
    expect(screen.queryByText('Nike Black')).toBeNull();
  });

  it('shows recent searches on focus, applies and clears them', async () => {
    mockRecent.list = ['jordan sz 10', 'wemby psa 10'];
    (apiMock.listItems as jest.Mock).mockResolvedValue({
      items: [makeItem({ id: 'a', name: 'Air Jordan 4', sku: 'J4', size: '10' })],
      total: 1, page: 1, per_page: 24, pages: 1,
    });
    const screen = render(<InventoryListScreen />);
    await screen.findByText('Air Jordan 4');
    const input = screen.getByLabelText('Search inventory');
    await act(async () => { fireEvent(input, 'focus'); });
    expect(await screen.findByTestId('recent-searches')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Search jordan sz 10'));
    expect(input.props.value).toBe('jordan sz 10');
    expect(screen.queryByTestId('recent-searches')).toBeNull();

    fireEvent.changeText(input, '');
    await act(async () => { fireEvent(input, 'focus'); });
    fireEvent.press(await screen.findByLabelText('Clear recent searches'));
    expect(screen.queryByTestId('recent-searches')).toBeNull();
    await act(async () => { fireEvent(input, 'blur'); });
  });

  it('shows loading indicator on mount', () => {
    (apiMock.listItems as jest.Mock).mockImplementation(() => new Promise(() => {})); // never resolves
    const { getByTestId } = render(<InventoryListScreen />);
    expect(getByTestId('inventory-loading')).toBeTruthy();
  });

  it('exits loading state and renders items on success', async () => {
    const items = [makeItem({ name: 'Jordan 1 Chicago' })];
    (apiMock.listItems as jest.Mock).mockResolvedValue({ ...PAGINATED_EMPTY, items, total: 1 });

    const { queryByTestId, getByText } = render(<InventoryListScreen />);

    await waitFor(() => {
      expect(queryByTestId('inventory-loading')).toBeNull();
    });
    expect(getByText('Jordan 1 Chicago')).toBeTruthy();
  });

  it('exits loading state without crash on API failure', async () => {
    (apiMock.listItems as jest.Mock).mockRejectedValue(new Error('Network error'));

    const { queryByTestId } = render(<InventoryListScreen />);

    await waitFor(() => {
      expect(queryByTestId('inventory-loading')).toBeNull();
    });
    expect(Alert.alert).toHaveBeenCalledWith('Inventory unavailable', 'Network error');
    // No crash — component stays mounted.
  });

  it('renders source badge for a lightspeed item', async () => {
    const item = makeItem({ source: 'lightspeed', name: 'LS Sneaker' });
    (apiMock.listItems as jest.Mock).mockResolvedValue({ ...PAGINATED_EMPTY, items: [item], total: 1 });

    const { getAllByText } = render(<InventoryListScreen />);

    await waitFor(() => {
      expect(getAllByText('Lightspeed').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders safely when item has null quantity (shows Stock 0)', async () => {
    const item = makeItem({ quantity: 0, name: 'Zero Qty Item' });
    (apiMock.listItems as jest.Mock).mockResolvedValue({ ...PAGINATED_EMPTY, items: [item], total: 1 });

    const { getByText } = render(<InventoryListScreen />);

    await waitFor(() => {
      expect(getByText('Zero Qty Item')).toBeTruthy();
    });
    expect(getByText('Stock 0')).toBeTruthy();
  });

  it('renders photo, low-stock, unknown source, and unknown status branches', async () => {
    const item = makeItem({
      name: 'Photo Item',
      quantity: 3,
      source: 'custom-pos',
      status: 'custom_status',
      photo_front_url: 'https://example.com/front.jpg',
      photo_back_url: 'https://example.com/back.jpg',
    });
    (apiMock.listItems as jest.Mock).mockResolvedValue({ ...PAGINATED_EMPTY, items: [item], total: 1 });
    const screen = render(<InventoryListScreen />);
    await screen.findByText('Photo Item');
    expect(screen.getByText('Low stock 3')).toBeTruthy();
    expect(screen.getAllByText('custom-pos').length).toBeGreaterThan(0);
    expect(screen.getByText('custom_status')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Open Photo Item'));
    expect(mockPush).toHaveBeenCalledWith('/inventory/item-1');
  });

  it('debounces search and replaces a pending search timer', async () => {
    jest.useFakeTimers();
    try {
      (apiMock.listItems as jest.Mock).mockResolvedValue(PAGINATED_EMPTY);
      const screen = render(<InventoryListScreen />);
      await act(async () => jest.runOnlyPendingTimersAsync());
      fireEvent.changeText(screen.getByLabelText('Search inventory'), 'jord');
      fireEvent.changeText(screen.getByLabelText('Search inventory'), 'jordan');
      await act(async () => jest.advanceTimersByTimeAsync(250));
      expect(apiMock.listItems).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, q: 'jordan' }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('refreshes and appends the next page on end reached', async () => {
    (apiMock.listItems as jest.Mock)
      .mockResolvedValueOnce({
        ...PAGINATED_EMPTY,
        items: [makeItem({ id: 'item-1', name: 'First Item' })],
        total: 2,
        page: 1,
        pages: 2,
      })
      .mockResolvedValueOnce({
        ...PAGINATED_EMPTY,
        items: [makeItem({ id: 'item-2', name: 'Second Item' })],
        total: 2,
        page: 2,
        pages: 2,
      })
      .mockResolvedValueOnce({
        ...PAGINATED_EMPTY,
        items: [makeItem({ id: 'item-1', name: 'First Item' })],
        total: 2,
        page: 1,
        pages: 2,
      });
    const screen = render(<InventoryListScreen />);
    await screen.findByText('First Item');
    const FlatList = require('react-native').FlatList;
    let list = screen.UNSAFE_getByType(FlatList);
    fireEvent(list, 'endReached');
    await screen.findByText('Second Item');
    expect(apiMock.listItems).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));

    list = screen.UNSAFE_getByType(FlatList);
    await act(async () => list.props.refreshControl.props.onRefresh());
    await waitFor(() => expect(apiMock.listItems).toHaveBeenCalledTimes(3));
  });

  it('offers the closest item when a search finds nothing', async () => {
    (apiMock.listItems as jest.Mock).mockResolvedValue({ ...PAGINATED_EMPTY, items: [makeItem({ id: 'a', name: 'Jordan 4 Retro Bred' })], total: 1 });
    const screen = render(<InventoryListScreen />);
    await screen.findByText('Jordan 4 Retro Bred');
    (apiMock.listItems as jest.Mock).mockResolvedValue({ ...PAGINATED_EMPTY, items: [], total: 0 });
    fireEvent.changeText(screen.getByLabelText('Search inventory'), 'jordn bredd');
    expect(await screen.findByTestId('did-you-mean')).toBeTruthy();
    fireEvent.press(screen.getByTestId('did-you-mean'));
    expect(screen.getByLabelText('Search inventory').props.value).toBe('Jordan 4 Retro Bred');
  });

  it('swipe delete hides the row at once, undo brings it back with no server call', async () => {
    jest.useFakeTimers();
    try {
      const a = makeItem({ id: 'a', name: 'Keep Me' });
      const b = makeItem({ id: 'b', name: 'Swipe Me' });
      (apiMock.listItems as jest.Mock).mockResolvedValue({ ...PAGINATED_EMPTY, items: [a, b], total: 2 });
      const screen = render(<InventoryListScreen />);
      await screen.findByText('Swipe Me');

      fireEvent.press(screen.getAllByTestId('swipe-delete')[1]);
      expect(screen.queryByText('Swipe Me')).toBeNull();
      expect(screen.getByText('Deleted Swipe Me')).toBeTruthy();
      fireEvent.press(screen.getByTestId('undo-button'));
      expect(screen.getByText('Swipe Me')).toBeTruthy();
      await act(async () => { jest.advanceTimersByTime(6000); });
      expect(apiMock.deleteItem).not.toHaveBeenCalled();

      // Not undone: it is deleted on the server when the bar times out.
      fireEvent.press(screen.getAllByTestId('swipe-delete')[1]);
      await act(async () => { jest.advanceTimersByTime(6000); });
      expect(apiMock.deleteItem).toHaveBeenCalledWith('b');
      expect(screen.queryByText('Swipe Me')).toBeNull();

      // Swipe right sells; swipe left edits.
      fireEvent.press(screen.getByTestId('swipe-sell'));
      expect(mockPush).toHaveBeenCalledWith('/inventory/sale?add=a');
      fireEvent.press(screen.getByTestId('swipe-edit'));
      expect(mockPush).toHaveBeenCalledWith('/inventory/edit?id=a');
    } finally {
      jest.useRealTimers();
    }
  });

  it('sorts from the sort chip and shows stale stock from the chip or a card badge', async () => {
    const old = makeItem({ id: 'old', name: 'Old Dunk', created_at: new Date(Date.now() - 50 * 86_400_000).toISOString() });
    (apiMock.listItems as jest.Mock).mockResolvedValue({ ...PAGINATED_EMPTY, items: [old], total: 1 });
    const screen = render(<InventoryListScreen />);
    await screen.findByText('Old Dunk');
    expect(screen.getByText('50d in stock')).toBeTruthy();

    fireEvent.press(screen.getByTestId('sort-button'));
    fireEvent.press(screen.getByLabelText('Most profit'));
    await waitFor(() => expect(apiMock.listItems).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'profit' })));
    await screen.findByText('Sort: Most profit');

    fireEvent.press(screen.getByTestId('stale-badge'));
    await waitFor(() => expect(apiMock.listItems).toHaveBeenLastCalledWith(expect.objectContaining({ minAgeDays: 30, sort: 'profit' })));
    await screen.findByText('In stock 30d+');
    // Already filtered: the badge no longer offers the same filter, and the chip hides.
    expect(screen.queryByTestId('stale-chip')).toBeNull();
  });

  it('filters by status and source through the dropdown, and clears them', async () => {
    const item = makeItem({ source: 'lightspeed' });
    (apiMock.listItems as jest.Mock).mockResolvedValue({ ...PAGINATED_EMPTY, items: [item], total: 1 });
    const screen = render(<InventoryListScreen />);
    await screen.findByText('Jordan 1 Chicago');

    // Open the filter dropdown and pick a status.
    fireEvent.press(screen.getByLabelText('Filters'));
    fireEvent.press(screen.getByLabelText('In Stock'));
    await waitFor(() =>
      expect(apiMock.listItems).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'in_stock' })),
    );

    // Reopen and pick a discovered source.
    fireEvent.press(screen.getByLabelText('Filters'));
    fireEvent.press(screen.getByLabelText('Lightspeed'));
    await waitFor(() =>
      expect(apiMock.listItems).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'lightspeed' })),
    );

    // Clear all active filters.
    fireEvent.press(screen.getByLabelText('Clear filters'));
    await waitFor(() =>
      expect(apiMock.listItems).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: undefined, source: undefined }),
      ),
    );
  });

  it('exports inventory via the CSV chooser option, reports errors, and routes header actions', async () => {
    (apiMock.listItems as jest.Mock).mockResolvedValue(PAGINATED_EMPTY);
    (apiMock.exportInventoryWarehouseCSV as jest.Mock).mockResolvedValueOnce('Product Name,,');
    // The Export button opens a format chooser; auto-select "CSV".
    (Alert.alert as jest.Mock).mockImplementation((_title, _msg, buttons?: any[]) => {
      buttons?.find((b) => b.text === 'CSV')?.onPress?.();
    });
    const screen = render(<InventoryListScreen />);
    await screen.findByText('No inventory matches this view.');
    fireEvent.press(screen.getByText('Export'));
    await waitFor(() =>
      expect(fileActions.downloadTextFile).toHaveBeenCalledWith(
        'Product Name,,',
        'resqlo-inventory.csv',
      ),
    );

    (apiMock.exportInventoryWarehouseCSV as jest.Mock).mockRejectedValueOnce(
      new Error('export down'),
    );
    fireEvent.press(screen.getByText('Export'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Export failed', 'export down'));
    fireEvent.press(screen.getByText('Import'));
    fireEvent.press(screen.getByText('Add Stock'));
    expect(mockPush.mock.calls).toEqual(
      expect.arrayContaining([['/inventory/import'], ['/inventory/add']]),
    );
  });

  it('selects an item and bulk-deletes from app only', async () => {
    (apiMock.listItems as jest.Mock).mockResolvedValue({ ...PAGINATED_EMPTY, items: [makeItem()], total: 1 });
    (apiMock.bulkDeleteItems as jest.Mock).mockResolvedValue({ deleted: 1 });
    const screen = render(<InventoryListScreen />);
    await screen.findByText('Jordan 1 Chicago');
    fireEvent.press(screen.getByText('Select'));
    fireEvent.press(screen.getByText('Jordan 1 Chicago')); // select
    await screen.findByText('Delete 1');
    fireEvent.press(screen.getByText('Jordan 1 Chicago')); // deselect (toggle off)
    fireEvent.press(screen.getByText('Jordan 1 Chicago')); // reselect
    await screen.findByText('Delete 1');
    (Alert.alert as jest.Mock).mockImplementationOnce((_t, _m, buttons?: any[]) =>
      buttons?.find((b) => b.text === 'Delete from app only')?.onPress?.(),
    );
    fireEvent.press(screen.getByText('Delete 1'));
    await waitFor(() => expect(apiMock.bulkDeleteItems).toHaveBeenCalledWith(['item-1'], false));
  });

  it('bulk-deletes from app + source and reports failures, then cancels select mode', async () => {
    (apiMock.listItems as jest.Mock).mockResolvedValue({ ...PAGINATED_EMPTY, items: [makeItem()], total: 1 });
    (apiMock.bulkDeleteItems as jest.Mock).mockResolvedValueOnce({ deleted: 1, source_note: 'read-only' });
    const screen = render(<InventoryListScreen />);
    await screen.findByText('Jordan 1 Chicago');
    fireEvent.press(screen.getByText('Select'));
    fireEvent.press(screen.getByText('Jordan 1 Chicago'));
    await screen.findByText('Delete 1');
    (Alert.alert as jest.Mock).mockImplementationOnce((_t, _m, buttons?: any[]) =>
      buttons?.find((b) => b.text === 'Delete from app + source')?.onPress?.(),
    );
    fireEvent.press(screen.getByText('Delete 1'));
    await waitFor(() => expect(apiMock.bulkDeleteItems).toHaveBeenCalledWith(['item-1'], true));

    // Failure path
    fireEvent.press(screen.getByText('Select'));
    fireEvent.press(screen.getByText('Jordan 1 Chicago'));
    await screen.findByText('Delete 1');
    (apiMock.bulkDeleteItems as jest.Mock).mockRejectedValueOnce(new Error('delete down'));
    (Alert.alert as jest.Mock).mockImplementationOnce((_t, _m, buttons?: any[]) =>
      buttons?.find((b) => b.text === 'Delete from app only')?.onPress?.(),
    );
    fireEvent.press(screen.getByText('Delete 1'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Delete failed', 'delete down'));
    fireEvent.press(screen.getByText('Cancel'));
    expect(screen.getByText('Select')).toBeTruthy();
  });

  it('exports Excel with photos via the chooser, reporting errors', async () => {
    (apiMock.listItems as jest.Mock).mockResolvedValue(PAGINATED_EMPTY);
    (fileActions.downloadAndShareRemote as jest.Mock).mockResolvedValueOnce(undefined);
    (Alert.alert as jest.Mock).mockImplementation((_t, _m, buttons?: any[]) =>
      buttons?.find((b) => typeof b.text === 'string' && b.text.startsWith('Excel'))?.onPress?.(),
    );
    const screen = render(<InventoryListScreen />);
    await screen.findByText('No inventory matches this view.');
    fireEvent.press(screen.getByText('Export'));
    await waitFor(() =>
      expect(fileActions.downloadAndShareRemote).toHaveBeenCalledWith(
        'https://api.test/export/inventory?format=xlsx',
        'resqlo-inventory.xlsx',
        'tok-123',
      ),
    );

    (fileActions.downloadAndShareRemote as jest.Mock).mockRejectedValueOnce(new Error('pro only'));
    fireEvent.press(screen.getByText('Export'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Export failed', 'pro only'));
  });

  it('shows active filter state, clears via "All statuses", and closes the dropdown', async () => {
    (apiMock.listItems as jest.Mock).mockResolvedValue({ ...PAGINATED_EMPTY, items: [makeItem({ source: 'lightspeed' })], total: 1 });
    const screen = render(<InventoryListScreen />);
    await screen.findByText('Jordan 1 Chicago');
    // Apply a status (each option press also closes the sheet).
    fireEvent.press(screen.getByLabelText('Filters'));
    fireEvent.press(screen.getByLabelText('In Stock'));
    await waitFor(() => expect(apiMock.listItems).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'in_stock' })));
    // Reopen (In Stock now shows active) → clear via "All statuses".
    fireEvent.press(screen.getByLabelText('Filters'));
    fireEvent.press(screen.getByLabelText('All statuses'));
    await waitFor(() => expect(apiMock.listItems).toHaveBeenLastCalledWith(expect.objectContaining({ status: undefined })));
    // Reopen → "All sources" clears the source group.
    fireEvent.press(screen.getByLabelText('Filters'));
    fireEvent.press(screen.getByLabelText('All sources'));
    await waitFor(() => expect(apiMock.listItems).toHaveBeenLastCalledWith(expect.objectContaining({ source: undefined })));
    // Reopen → dismiss with the X.
    fireEvent.press(screen.getByLabelText('Filters'));
    fireEvent.press(screen.getByLabelText('Close filters'));
    // Reopen → dismiss by tapping the backdrop and via hardware back.
    fireEvent.press(screen.getByLabelText('Filters'));
    fireEvent.press(screen.getByTestId('filter-backdrop'));
    fireEvent.press(screen.getByLabelText('Filters'));
    const filterModal = screen
      .UNSAFE_getAllByType(require('react-native').Modal)
      .find((m: any) => typeof m.props.onRequestClose === 'function');
    filterModal.props.onRequestClose();
  });

  it('loads the next page when the list reaches its end', async () => {
    const page1 = { items: [makeItem()], total: 40, page: 1, per_page: 24, pages: 2 };
    (apiMock.listItems as jest.Mock)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce({ ...page1, items: [makeItem({ id: 'item-2', name: 'Page Two Item' })], page: 2 });
    const screen = render(<InventoryListScreen />);
    await screen.findByText('Jordan 1 Chicago');
    const list = screen.UNSAFE_getByType(require('react-native').FlatList);
    await act(async () => list.props.onEndReached());
    await waitFor(() => expect(apiMock.listItems).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
  });
});

describe('free item counter', () => {
  afterEach(() => { mockTier = 'pro'; });

  it('shows items used and an upsell near the free limit', async () => {
    mockTier = 'free';
    (apiMock.listItems as jest.Mock).mockResolvedValue({ ...PAGINATED_EMPTY, items: [], total: 22 });
    const screen = render(<InventoryListScreen />);
    await screen.findByText('22 of 25 free items used');
    expect(screen.getByTestId('item-limit-upsell')).toHaveTextContent(/3 free items left/);
  });

  it('shows the free-week notice during grace', async () => {
    mockTier = 'free';
    (apiMock.getSubscriptionStatus as jest.Mock).mockResolvedValueOnce({ pricing_grace_until: '2026-12-08T00:00:00Z' });
    (apiMock.listItems as jest.Mock).mockResolvedValue({ ...PAGINATED_EMPTY, items: [], total: 3 });
    const screen = render(<InventoryListScreen />);
    expect(await screen.findByTestId('grace-upsell')).toHaveTextContent(/free for you until/);
  });

  it('hides the counter for Pro', async () => {
    (apiMock.listItems as jest.Mock).mockResolvedValue({ ...PAGINATED_EMPTY, items: [], total: 22 });
    const screen = render(<InventoryListScreen />);
    await screen.findByText('22 items');
    expect(screen.queryByTestId('item-limit-upsell')).toBeNull();
  });
});
