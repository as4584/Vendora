jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

const mockReplace = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
}));

jest.mock('../services/api', () => ({
  listItems: jest.fn(),
  createTransaction: jest.fn(),
}));

import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import QuickSaleScreen from '../app/(tabs)/inventory/sale';

const ITEM = {
  id: 'item-1',
  user_id: 'user-1',
  name: 'Jordan 1 Retro High',
  category: 'Sneakers',
  sku: 'AJ1-001',
  upc: null,
  size: null,
  color: 'Bred',
  condition: 'New',
  serial_number: null,
  custom_attributes: {
    variants: [
      { size: 'US 8', quantity: 2 },
      { size: 'US 9', quantity: 3 },
      { size: 'US 10', quantity: 1 },
    ],
  },
  buy_price: '150.00',
  expected_sell_price: '340.00',
  actual_sell_price: null,
  platform: 'StockX',
  status: 'in_stock',
  photo_front_url: null,
  photo_back_url: null,
  quantity: 6,
  vendor_name: 'Kick Game Supply',
  notes: null,
  source: 'manual',
  external_id: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('QuickSaleScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.[0]?.onPress?.();
    });
    (apiMock.listItems as jest.Mock).mockResolvedValue({
      items: [ITEM],
      total: 1,
      page: 1,
      per_page: 100,
      pages: 1,
    });
    (apiMock.createTransaction as jest.Mock).mockResolvedValue({
      id: 'txn-1',
      gross_amount: '340.00',
      method: 'cash',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows stock impact and logs a size-aware quick sale', async () => {
    const screen = render(<QuickSaleScreen />);

    await waitFor(() => {
      expect(screen.getByText('Jordan 1 Retro High')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    });

    await waitFor(() => {
      expect(screen.getByText('Available after sale: 5')).toBeTruthy();
      expect(screen.getByText('US 9 (3)')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('US 9 (3)'));
    });

    await waitFor(() => {
      expect(screen.getByText('US 9 (3)')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Log Sale'));
    });

    await waitFor(() => {
      expect(apiMock.createTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          item_id: 'item-1',
          quantity: 1,
          notes: 'Size sold: US 9',
        }),
      );
    });
  });
});
