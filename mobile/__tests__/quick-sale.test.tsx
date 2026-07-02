import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
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
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace, push: jest.fn() }) }));

jest.mock('../services/api', () => ({
  listItems: jest.fn(),
  createTransaction: jest.fn(),
}));

const ITEM = {
  id: 'item-1', name: 'Jordan 1 Retro High', category: 'Sneakers', sku: 'AJ1-001',
  buy_price: '150.00', expected_sell_price: '340.00', status: 'in_stock', quantity: 6,
  custom_attributes: {}, source: 'manual',
};
const ITEM2 = {
  id: 'item-2', name: 'Sony WH-1000XM5', category: 'Electronics', sku: 'SONY-1',
  buy_price: '120.00', expected_sell_price: '210.00', status: 'in_stock', quantity: 3,
  custom_attributes: {}, source: 'manual',
};

describe('QuickSaleScreen (multi-item cart)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      buttons?.[0]?.onPress?.();
    });
    (apiMock.listItems as jest.Mock).mockResolvedValue({ items: [ITEM, ITEM2], total: 2, page: 1, per_page: 100, pages: 1 });
    (apiMock.createTransaction as jest.Mock).mockResolvedValue({ id: 'txn-1', gross_amount: '340.00', method: 'cash' });
  });

  afterEach(() => jest.restoreAllMocks());

  it('adds multiple items and logs one transaction per line', async () => {
    const screen = render(<QuickSaleScreen />);
    await screen.findByText('Jordan 1 Retro High');

    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.press(screen.getByText('Sony WH-1000XM5'));
    // Toggle Sony off then back on (covers the cart remove/add branches).
    // Once added the name appears in both the list and cart, so target the list row by label.
    fireEvent.press(screen.getByLabelText('Remove Sony WH-1000XM5'));
    fireEvent.press(screen.getByLabelText('Add Sony WH-1000XM5'));
    // Cart shows both lines + a total (340 + 210 = 550).
    await waitFor(() => expect(screen.getByText(/Cart · 2 items/)).toBeTruthy());

    fireEvent.press(screen.getByText(/Log Sale/));
    await waitFor(() => expect(apiMock.createTransaction).toHaveBeenCalledTimes(2));
    expect(apiMock.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ item_id: 'item-1', quantity: 1, gross_amount: '340.00' }),
    );
    expect(apiMock.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ item_id: 'item-2', quantity: 1, gross_amount: '210.00' }),
    );
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
  });

  it('adjusts line quantity and applies method + fee', async () => {
    const screen = render(<QuickSaleScreen />);
    await screen.findByText('Jordan 1 Retro High');
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.press(screen.getByLabelText('Increase Jordan 1 Retro High')); // qty 2
    fireEvent.press(screen.getByLabelText('Increase Jordan 1 Retro High')); // qty 3
    fireEvent.press(screen.getByLabelText('Decrease Jordan 1 Retro High')); // back to qty 2
    fireEvent.press(screen.getByText('PAYPAL'));
    fireEvent.changeText(screen.getByLabelText('Fee amount'), '5');
    fireEvent.press(screen.getByText(/Log Sale/));
    await waitFor(() =>
      expect(apiMock.createTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ item_id: 'item-1', method: 'paypal', quantity: 2, gross_amount: '680.00', fee_amount: '5' }),
      ),
    );
  });

  it('blocks logging with an empty cart', async () => {
    const screen = render(<QuickSaleScreen />);
    await screen.findByText('Jordan 1 Retro High');
    fireEvent.press(screen.getByText(/Log Sale/));
    expect(Alert.alert).toHaveBeenLastCalledWith('No items selected', 'Tap items above to add them to this sale.');
    expect(apiMock.createTransaction).not.toHaveBeenCalled();
  });

  it('reports inventory load failures and filters by search', async () => {
    (apiMock.listItems as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    const failed = render(<QuickSaleScreen />);
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith('Quick sale unavailable', 'Could not load sellable inventory.'),
    );
    failed.unmount();

    const screen = render(<QuickSaleScreen />);
    await screen.findByText('Jordan 1 Retro High');
    fireEvent.changeText(screen.getByLabelText('Search sale inventory'), 'sony');
    expect(screen.queryByText('Jordan 1 Retro High')).toBeNull();
    expect(screen.getByText('Sony WH-1000XM5')).toBeTruthy();
  });

  it('reports transaction failures', async () => {
    (apiMock.createTransaction as jest.Mock).mockRejectedValueOnce(new Error('payment down'));
    const screen = render(<QuickSaleScreen />);
    await screen.findByText('Jordan 1 Retro High');
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.press(screen.getByText(/Log Sale/));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Sale failed', 'payment down'));
  });
});
