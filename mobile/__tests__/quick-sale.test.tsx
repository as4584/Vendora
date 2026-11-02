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
  createSaleOrder: jest.fn(),
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
    (apiMock.createSaleOrder as jest.Mock).mockResolvedValue({
      order_id: 'order-1', gross_amount: '550.00', fee_amount: '0.00', net_amount: '550.00', transactions: [],
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('logs the whole cart as ONE order (all-or-nothing on the server)', async () => {
    const screen = render(<QuickSaleScreen />);
    await screen.findByText('Jordan 1 Retro High');

    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.press(screen.getByText('Sony WH-1000XM5'));
    // Toggle Sony off then back on (covers the cart remove/add branches).
    fireEvent.press(screen.getByLabelText('Remove Sony WH-1000XM5'));
    fireEvent.press(screen.getByLabelText('Add Sony WH-1000XM5'));
    await waitFor(() => expect(screen.getByText(/Cart · 2 items/)).toBeTruthy());

    fireEvent.press(screen.getByText(/Log Sale/));
    await waitFor(() => expect(apiMock.createSaleOrder).toHaveBeenCalledTimes(1));
    expect(apiMock.createSaleOrder).toHaveBeenCalledWith({
      lines: [
        { item_id: 'item-1', quantity: 1, unit_price: '340.00' },
        { item_id: 'item-2', quantity: 1, unit_price: '210.00' },
      ],
      method: 'cash',
      fee_amount: '0.00',
      notes: undefined,
    });
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
      expect(apiMock.createSaleOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'paypal',
          fee_amount: '5.00',
          lines: [{ item_id: 'item-1', quantity: 2, unit_price: '340.00' }],
        }),
      ),
    );
  });

  it('lets the seller haggle the price per line', async () => {
    const screen = render(<QuickSaleScreen />);
    await screen.findByText('Jordan 1 Retro High');
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.changeText(screen.getByLabelText('Sale price for Jordan 1 Retro High'), '300');
    expect(screen.getByText(/Log Sale · \$300\.00/)).toBeTruthy();
    fireEvent.press(screen.getByText(/Log Sale/));
    await waitFor(() =>
      expect(apiMock.createSaleOrder).toHaveBeenCalledWith(
        expect.objectContaining({ lines: [{ item_id: 'item-1', quantity: 1, unit_price: '300.00' }] }),
      ),
    );
  });

  it('rejects a fee larger than the sale', async () => {
    const screen = render(<QuickSaleScreen />);
    await screen.findByText('Jordan 1 Retro High');
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.changeText(screen.getByLabelText('Fee amount'), '999');
    fireEvent.press(screen.getByText(/Log Sale/));
    expect(Alert.alert).toHaveBeenLastCalledWith('Check the fee', "The fee can't be more than the sale total.");
    expect(apiMock.createSaleOrder).not.toHaveBeenCalled();
  });

  it('says when the order was queued offline', async () => {
    (apiMock.createSaleOrder as jest.Mock).mockResolvedValueOnce({
      order_id: 'tmp', gross_amount: '340.00', fee_amount: '0.00', net_amount: '340.00', transactions: [], pending: true,
    });
    const screen = render(<QuickSaleScreen />);
    await screen.findByText('Jordan 1 Retro High');
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.press(screen.getByText(/Log Sale/));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Sale queued offline', expect.any(String), expect.any(Array)));
  });

  it('blocks logging with an empty cart', async () => {
    const screen = render(<QuickSaleScreen />);
    await screen.findByText('Jordan 1 Retro High');
    fireEvent.press(screen.getByText(/Log Sale/));
    expect(Alert.alert).toHaveBeenLastCalledWith('No items selected', 'Tap items above to add them to this sale.');
    expect(apiMock.createSaleOrder).not.toHaveBeenCalled();
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
    (apiMock.createSaleOrder as jest.Mock).mockRejectedValueOnce(new Error('payment down'));
    const screen = render(<QuickSaleScreen />);
    await screen.findByText('Jordan 1 Retro High');
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.press(screen.getByText(/Log Sale/));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Sale failed', 'payment down'));
  });
});
