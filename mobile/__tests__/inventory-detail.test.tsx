/**
 * Inventory Detail screen regression tests
 *
 * Covers:
 *  1. Loading indicator shown on mount (testID="item-detail-loading")
 *  2. Item name, status badge, source badge render on success
 *  3. No crash with null optional fields (null source, external_id, photos)
 *  4. resolveQty correctly sums variants when present
 *  5. router.back() called after getItem 404 error (navigation regression)
 */

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as apiMock from '../services/api';
import ItemDetailScreen from '../app/(tabs)/inventory/[id]';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

const mockBack = jest.fn();
const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockSearchParams = jest.fn((): { id?: string } => ({ id: 'test-item-id' }));

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockSearchParams(),
  useRouter: () => ({ back: mockBack, push: mockPush, replace: mockReplace }),
  Stack: { Screen: () => null },
}));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ status: 'denied' })),
  requestCameraPermissionsAsync: jest.fn(async () => ({ status: 'denied' })),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true })),
  launchCameraAsync: jest.fn(async () => ({ canceled: true })),
  MediaTypeOptions: { Images: 'images' },
}));

jest.mock('../services/api', () => ({
  getItem: jest.fn(),
  getItemActivity: jest.fn(async () => []),
  listTransactions: jest.fn(async () => ({ items: [], total: 0, page: 1, per_page: 10, pages: 0 })),
  listInvoices: jest.fn(async () => ({ items: [], total: 0, page: 1, per_page: 10, pages: 0 })),
  getMarketPrice: jest.fn(async () => { throw new Error('no market data'); }),
  getPricingSuggestion: jest.fn(async () => { throw new Error('no suggestion'); }),
  pushItemToLightspeed: jest.fn(),
  updateItemStatus: jest.fn(),
  deleteItem: jest.fn(),
  uploadItemPhotos: jest.fn(),
}));

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-item-id',
    user_id: 'user-1',
    name: 'Jordan 1 Retro',
    category: 'sneakers',
    sku: 'J1-001',
    upc: null,
    size: '10',
    color: null,
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
    quantity: 1,
    vendor_name: null,
    notes: null,
    source: null,
    external_id: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBack.mockClear();
  mockPush.mockClear();
  mockReplace.mockClear();
  mockSearchParams.mockReturnValue({ id: 'test-item-id' });
});

describe('ItemDetailScreen', () => {
  it('loads market pricing and publishes the item to Lightspeed', async () => {
    (apiMock.getItem as jest.Mock).mockResolvedValue(makeItem({ upc: '123' }));
    (apiMock.getMarketPrice as jest.Mock).mockResolvedValue({ sources: [{ source: 'ebay', label: 'eBay', price: 180 }], internal_history: { avg_sold_price: 170, sample_count: 2 } });
    (apiMock.getPricingSuggestion as jest.Mock).mockResolvedValue({ item_id: 'test-item-id', suggested_price: 175, reason: 'Based on recent sales', confidence: 'high', basis: 'history' });
    (apiMock.pushItemToLightspeed as jest.Mock).mockResolvedValue({ items_created: 1, items_updated: 0, errors_count: 0 });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const screen = render(<ItemDetailScreen />); await screen.findByText('Check Market Price'); fireEvent.press(screen.getByText('Check Market Price'));
    await screen.findByText('$175.00'); expect(screen.getByText('eBay')).toBeTruthy(); expect(apiMock.getMarketPrice).toHaveBeenCalledWith('Jordan 1 Retro', '123');
    fireEvent.press(screen.getByText('Publish to Lightspeed'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Published to Lightspeed', 'A linked Lightspeed catalog item was created.'));
    alertSpy.mockRestore();
  });

  it('reports market and Lightspeed failures and updated publish', async () => {
    (apiMock.getItem as jest.Mock).mockResolvedValue(makeItem());
    (apiMock.getMarketPrice as jest.Mock).mockRejectedValue(new Error('market down'));
    (apiMock.pushItemToLightspeed as jest.Mock).mockRejectedValueOnce(new Error('connect first')).mockResolvedValueOnce({ items_created: 0, items_updated: 1, errors_count: 0 });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const screen = render(<ItemDetailScreen />); await screen.findByText('Check Market Price'); fireEvent.press(screen.getByText('Check Market Price'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Market pricing unavailable', 'market down'));
    fireEvent.press(screen.getByText('Publish to Lightspeed'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Publish failed', 'connect first'));
    fireEvent.press(screen.getByText('Publish to Lightspeed'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Published to Lightspeed', 'The linked Lightspeed catalog item was updated.'));
    alertSpy.mockRestore();
  });

  it('renders a safe low-data pricing suggestion', async () => {
    (apiMock.getItem as jest.Mock).mockResolvedValue(makeItem());
    (apiMock.getMarketPrice as jest.Mock).mockResolvedValue({ sources: [], internal_history: { avg_sold_price: null, sample_count: 0 } });
    (apiMock.getPricingSuggestion as jest.Mock).mockResolvedValue({ item_id: 'test-item-id', suggested_price: null, reason: 'Add more sales data', confidence: 'low', basis: 'insufficient_data' });
    const screen = render(<ItemDetailScreen />); await screen.findByText('Check Market Price'); fireEvent.press(screen.getByText('Check Market Price'));
    await screen.findByText('More sales data needed');
  });
  it('shows loading indicator on mount before API resolves', async () => {
    // Hold the API promise so loading state is visible
    let resolve!: (v: unknown) => void;
    (apiMock.getItem as jest.Mock).mockReturnValue(new Promise(r => { resolve = r; }));

    const { getByTestId } = render(<ItemDetailScreen />);

    expect(getByTestId('item-detail-loading')).toBeTruthy();

    // Cleanup: resolve so no pending async tasks
    resolve(makeItem());
    await waitFor(() => {});
  });

  it('cancels safely before the item or optional history promises resolve', async () => {
    let resolveItem!: (value: unknown) => void;
    (apiMock.getItem as jest.Mock).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveItem = resolve;
      }),
    );
    const first = render(<ItemDetailScreen />);
    first.unmount();
    await act(async () => resolveItem(makeItem()));

    let resolveActivity!: (value: unknown) => void;
    let resolveTransactions!: (value: unknown) => void;
    let resolveInvoices!: (value: unknown) => void;
    (apiMock.getItem as jest.Mock).mockResolvedValueOnce(makeItem());
    (apiMock.getItemActivity as jest.Mock).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveActivity = resolve;
      }),
    );
    (apiMock.listTransactions as jest.Mock).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTransactions = resolve;
      }),
    );
    (apiMock.listInvoices as jest.Mock).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInvoices = resolve;
      }),
    );
    const second = render(<ItemDetailScreen />);
    await waitFor(() => expect(apiMock.getItemActivity).toHaveBeenCalled());
    second.unmount();
    await act(async () => {
      resolveActivity([]);
      resolveTransactions({ items: [] });
      resolveInvoices({ items: [] });
    });
  });

  it('renders item name and status badge after successful load', async () => {
    (apiMock.getItem as jest.Mock).mockResolvedValue(makeItem());

    const screen = render(<ItemDetailScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('item-detail-content')).toBeTruthy();
    });

    expect(screen.getByText('Jordan 1 Retro')).toBeTruthy();
    expect(screen.getAllByText('In Stock').length).toBeGreaterThanOrEqual(1);
  });

  it('renders source badge for a lightspeed item', async () => {
    (apiMock.getItem as jest.Mock).mockResolvedValue(
      makeItem({ source: 'lightspeed', external_id: 'LS-123' }),
    );

    const screen = render(<ItemDetailScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('item-detail-content')).toBeTruthy();
    });

    expect(screen.getAllByText('Lightspeed').length).toBeGreaterThanOrEqual(1);
  });

  it('renders without crash when all optional fields are null', async () => {
    (apiMock.getItem as jest.Mock).mockResolvedValue(
      makeItem({
        source: null,
        external_id: null,
        photo_front_url: null,
        photo_back_url: null,
        vendor_name: null,
        notes: null,
        sku: null,
        upc: null,
      }),
    );

    const screen = render(<ItemDetailScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('item-detail-content')).toBeTruthy();
    });
  });

  it('renders Out of stock note when quantity is 0', async () => {
    (apiMock.getItem as jest.Mock).mockResolvedValue(makeItem({ quantity: 0 }));

    const screen = render(<ItemDetailScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('item-detail-content')).toBeTruthy();
    });

    expect(screen.getByText('Out of stock')).toBeTruthy();
  });

  it('resolves total qty from variants when custom_attributes.variants present', async () => {
    (apiMock.getItem as jest.Mock).mockResolvedValue(
      makeItem({
        quantity: 1,
        custom_attributes: {
          variants: [
            { size: '9', quantity: 2 },
            { size: '10', quantity: 3 },
            { size: '11', quantity: 1 },
          ],
        },
      }),
    );

    const screen = render(<ItemDetailScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('item-detail-content')).toBeTruthy();
    });

    expect(screen.getByText('6')).toBeTruthy();
  });

  it('shows a retryable error view after getItem throws, then recovers', async () => {
    (apiMock.getItem as jest.Mock).mockRejectedValueOnce(new Error('Not found'));
    const screen = render(<ItemDetailScreen />);

    await screen.findByTestId('item-detail-error');
    expect(screen.getByText('Not found')).toBeTruthy();

    // Retry succeeds and the content renders.
    (apiMock.getItem as jest.Mock).mockResolvedValueOnce(makeItem());
    fireEvent.press(screen.getByText('Retry'));
    await screen.findByTestId('item-detail-content');
  });

  it('shows an error view for a missing route ID without making an API request', async () => {
    mockSearchParams.mockReturnValue({});
    const screen = render(<ItemDetailScreen />);
    await screen.findByTestId('item-detail-error');
    expect(screen.getByText('This item link is missing an inventory ID.')).toBeTruthy();
    expect(apiMock.getItem).not.toHaveBeenCalled();
  });

  it('renders sales, invoice, and stock activity timelines', async () => {
    (apiMock.getItem as jest.Mock).mockResolvedValue(makeItem());
    (apiMock.getItemActivity as jest.Mock).mockResolvedValue([
      {
        id: 'activity-1',
        event_type: 'stock_added',
        delta_quantity: 2,
        quantity_after: 3,
        source_type: null,
        created_at: '2026-01-01T00:00:00Z',
      },
    ]);
    (apiMock.listTransactions as jest.Mock).mockResolvedValue({
      items: [
        {
          id: 'tx-1',
          method: 'cash',
          gross_amount: '200',
          quantity: 1,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    (apiMock.listInvoices as jest.Mock).mockResolvedValue({
      items: [
        {
          id: 'invoice-1',
          customer_name: 'Taylor',
          status: 'paid',
          total: '200',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    const screen = render(<ItemDetailScreen />);
    await screen.findByTestId('item-detail-content');
    expect(screen.getByText('CASH')).toBeTruthy();
    expect(screen.getByText('Taylor')).toBeTruthy();
    expect(screen.getByText(/stock added/)).toBeTruthy();
  });

  it('keeps the item usable when optional history requests fail', async () => {
    (apiMock.getItem as jest.Mock).mockResolvedValue(makeItem());
    (apiMock.getItemActivity as jest.Mock).mockRejectedValue(new Error('activity down'));
    (apiMock.listTransactions as jest.Mock).mockRejectedValue(new Error('transactions down'));
    (apiMock.listInvoices as jest.Mock).mockRejectedValue(new Error('invoices down'));
    const screen = render(<ItemDetailScreen />);
    await screen.findByTestId('item-detail-content');
    expect(screen.getByText('No stock activity recorded yet.')).toBeTruthy();
  });

  it('updates item status and reports transition failures', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    (apiMock.getItem as jest.Mock).mockResolvedValue(makeItem());
    (apiMock.updateItemStatus as jest.Mock).mockResolvedValueOnce(
      makeItem({ status: 'listed' }),
    );
    const screen = render(<ItemDetailScreen />);
    await screen.findByTestId('item-detail-content');
    fireEvent.press(screen.getByText('Mark Listed'));
    await waitFor(() => expect(apiMock.updateItemStatus).toHaveBeenCalledWith('test-item-id', 'listed'));
    expect(screen.getAllByText('Listed').length).toBeGreaterThan(0);

    (apiMock.updateItemStatus as jest.Mock).mockRejectedValueOnce(new Error('transition denied'));
    fireEvent.press(screen.getByText('Mark Sold'));
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('Status update failed', 'transition denied'),
    );
    alertSpy.mockRestore();
  });

  it('handles photo permission, front/back selection, upload success, and upload failure', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const picker = ImagePicker as jest.Mocked<typeof ImagePicker>;
    (apiMock.getItem as jest.Mock).mockResolvedValue(makeItem());
    const screen = render(<ItemDetailScreen />);
    await screen.findByTestId('item-detail-content');
    fireEvent.press(screen.getByLabelText('Update front photo'));
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        'Permission required',
        'Allow photo library access to update item photos.',
      ),
    );

    picker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ status: 'granted' } as any);
    picker.launchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ base64: 'front-bytes', uri: 'front-uri' }],
    } as any);
    (apiMock.uploadItemPhotos as jest.Mock).mockResolvedValueOnce(
      makeItem({ photo_front_url: 'data:image/jpeg;base64,front-bytes' }),
    );
    fireEvent.press(screen.getByLabelText('Update front photo'));
    await waitFor(() =>
      expect(apiMock.uploadItemPhotos).toHaveBeenCalledWith(
        'test-item-id',
        'data:image/jpeg;base64,front-bytes',
        undefined,
      ),
    );

    fireEvent.press(screen.getByLabelText('Show back photo'));
    fireEvent.press(screen.getByLabelText('Show front photo'));
    fireEvent.press(screen.getByLabelText('Show back photo'));
    fireEvent.press(screen.getByLabelText('Show front thumbnail'));
    fireEvent.press(screen.getByLabelText('Show back thumbnail'));
    picker.launchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ base64: null, uri: 'back-uri' }],
    } as any);
    (apiMock.uploadItemPhotos as jest.Mock).mockRejectedValueOnce(new Error('upload down'));
    fireEvent.press(screen.getByLabelText('Update back photo'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Upload failed', 'upload down'));
    alertSpy.mockRestore();
  });

  it('opens full edit and confirms successful or failed deletion', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    (apiMock.getItem as jest.Mock).mockResolvedValue(makeItem());
    (apiMock.deleteItem as jest.Mock).mockResolvedValueOnce(undefined);
    const screen = render(<ItemDetailScreen />);
    await screen.findByTestId('item-detail-content');
    fireEvent.press(screen.getByText('Edit'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/(tabs)/inventory/edit',
      params: { id: 'test-item-id' },
    });

    fireEvent.press(screen.getByText('Delete Item'));
    let actions = alertSpy.mock.calls.at(-1)?.[2];
    await act(async () => actions[1].onPress());
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/inventory');

    (apiMock.deleteItem as jest.Mock).mockRejectedValueOnce(new Error('delete down'));
    fireEvent.press(screen.getByText('Delete Item'));
    actions = alertSpy.mock.calls.at(-1)?.[2];
    await act(async () => actions[1].onPress());
    expect(alertSpy).toHaveBeenLastCalledWith('Delete failed', 'delete down');
    alertSpy.mockRestore();
  });
});
