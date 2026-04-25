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

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'test-item-id' }),
  useRouter: () => ({ back: mockBack, push: mockPush, replace: jest.fn() }),
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
  updateItemStatus: jest.fn(),
  deleteItem: jest.fn(),
  uploadItemPhotos: jest.fn(),
}));

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import * as apiMock from '../services/api';
import ItemDetailScreen from '../app/(tabs)/inventory/[id]';

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
});

describe('ItemDetailScreen', () => {
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

  it('calls router.back() after getItem throws an error', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(
      (_title, _msg, buttons) => {
        // Press the OK button programmatically
        buttons?.[0]?.onPress?.();
      },
    );

    (apiMock.getItem as jest.Mock).mockRejectedValue(new Error('Not found'));

    render(<ItemDetailScreen />);

    await waitFor(() => {
      expect(mockBack).toHaveBeenCalledTimes(1);
    });

    alertSpy.mockRestore();
  });
});
