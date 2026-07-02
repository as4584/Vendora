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

jest.mock('@react-native-async-storage/async-storage', () =>
  require('../__mocks__/async-storage'),
);
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useFocusEffect: (cb: () => void) => {
    // Fire once like useEffect in tests
    const React = require('react');
    React.useEffect(cb, []);
  },
}));
jest.mock('../services/api', () => ({
  listItems: jest.fn(),
  exportInventoryCSV: jest.fn(),
  exportInventoryWarehouseCSV: jest.fn(),
}));
jest.mock('../utils/fileActions', () => ({
  downloadTextFile: jest.fn(),
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
        'vendora-inventory.csv',
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
});
