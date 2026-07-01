import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import QuickSaleScreen from '../app/(tabs)/inventory/sale';

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

  it('reports inventory loading failures and filters by name, sku, or category', async () => {
    (apiMock.listItems as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    const failed = render(<QuickSaleScreen />);
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'Quick sale unavailable',
        'Could not load sellable inventory.',
      ),
    );
    failed.unmount();

    (apiMock.listItems as jest.Mock).mockResolvedValueOnce({ items: [ITEM] });
    const screen = render(<QuickSaleScreen />);
    await screen.findByText('Jordan 1 Retro High');
    fireEvent.changeText(screen.getByLabelText('Search sale inventory'), 'aj1');
    expect(screen.getByText('Jordan 1 Retro High')).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText('Search sale inventory'), 'no-match');
    expect(screen.queryByText('Jordan 1 Retro High')).toBeNull();
  });

  it('requires an amount and a size for variant inventory', async () => {
    const screen = render(<QuickSaleScreen />);
    await screen.findByText('Jordan 1 Retro High');
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.changeText(screen.getByLabelText('Sale amount'), '');
    fireEvent.press(screen.getByText('Log Sale'));
    expect(Alert.alert).toHaveBeenLastCalledWith(
      'Sale amount required',
      'Enter the amount collected from the sale.',
    );
    fireEvent.changeText(screen.getByLabelText('Sale amount'), '340');
    fireEvent.press(screen.getByText('Log Sale'));
    expect(Alert.alert).toHaveBeenLastCalledWith(
      'Size required',
      'Choose the size that was sold before continuing.',
    );
    expect(apiMock.createTransaction).not.toHaveBeenCalled();
  });

  it('logs a standalone payment with method, fees, and notes', async () => {
    const screen = render(<QuickSaleScreen />);
    await screen.findByText(/Skip/);
    fireEvent.press(screen.getByText(/Skip/));
    fireEvent.press(screen.getByText('PAYPAL'));
    fireEvent.changeText(screen.getByLabelText('Sale amount'), '50');
    fireEvent.changeText(screen.getByLabelText('Fee amount'), '2');
    fireEvent.changeText(screen.getByLabelText('Sale notes'), 'Meetup sale');
    fireEvent.press(screen.getByText('Log Sale'));
    await waitFor(() =>
      expect(apiMock.createTransaction).toHaveBeenCalledWith({
        item_id: undefined,
        method: 'paypal',
        gross_amount: '50',
        fee_amount: '2',
        quantity: 1,
        notes: 'Meetup sale',
      }),
    );
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
  });

  it('auto-selects a single size, normalizes quantity, and reports transaction failures', async () => {
    const single = {
      ...ITEM,
      custom_attributes: { variants: [{ size: 'US 8', quantity: 2 }] },
    };
    (apiMock.listItems as jest.Mock).mockResolvedValueOnce({ items: [single] });
    (apiMock.createTransaction as jest.Mock).mockRejectedValueOnce(new Error('payment down'));
    const screen = render(<QuickSaleScreen />);
    await screen.findByText('Jordan 1 Retro High');
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.changeText(screen.getByLabelText('Sale quantity'), '0');
    fireEvent.changeText(screen.getByLabelText('Fee amount'), '');
    fireEvent.press(screen.getByText('Log Sale'));
    await waitFor(() =>
      expect(apiMock.createTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          quantity: 1,
          fee_amount: '0.00',
          notes: 'Size sold: US 8',
        }),
      ),
    );
    expect(Alert.alert).toHaveBeenCalledWith('Sale failed', 'payment down');
  });
});
