import React from 'react';
import { Alert, Share } from 'react-native';
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
const mockPush = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
  useLocalSearchParams: () => mockParams,
}));

let mockPermission: { granted: boolean } | null = { granted: true };
const mockRequestPermission = jest.fn(async () => ({ granted: false }));
let mockOnScan: ((e: { data: string }) => void) | undefined;
jest.mock('expo-camera', () => {
  const { View } = require('react-native');
  const ReactModule = require('react');
  return {
    useCameraPermissions: () => [mockPermission, mockRequestPermission],
    CameraView: (props: any) => {
      mockOnScan = props.onBarcodeScanned;
      return ReactModule.createElement(View, { testID: 'camera-view' });
    },
  };
});

jest.mock('../services/api', () => ({
  listItems: jest.fn(),
  createSaleOrder: jest.fn(),
  getMe: jest.fn(),
  updateProfile: jest.fn(),
}));

const ITEM = {
  id: 'item-1', name: 'Jordan 1 Retro High', category: 'Sneakers', sku: 'AJ1-001', upc: '012345678905',
  buy_price: '150.00', expected_sell_price: '340.00', status: 'in_stock', quantity: 6,
  custom_attributes: {}, source: 'manual',
};
const ITEM2 = {
  id: 'item-2', name: 'Sony WH-1000XM5', category: 'Electronics', sku: 'SONY-1', upc: null,
  buy_price: '120.00', expected_sell_price: '210.00', status: 'in_stock', quantity: 3,
  custom_attributes: {}, source: 'manual',
};
const SIZED = {
  id: 'item-3', name: 'Dunk Low Panda', category: 'Sneakers', sku: 'DD1391', upc: null,
  buy_price: '90.00', expected_sell_price: '120.00', status: 'in_stock', quantity: 3,
  custom_attributes: { variants: [{ size: '9', quantity: 1 }, { size: '10.5', quantity: 2 }, { size: '12', quantity: 0 }] },
  source: 'manual',
};

const ORDER = { order_id: 'order-1', gross_amount: '550.00', fee_amount: '0.00', net_amount: '550.00', transactions: [] };

async function ready() {
  const screen = render(<QuickSaleScreen />);
  await screen.findByText('Jordan 1 Retro High');
  return screen;
}

describe('QuickSaleScreen (checkout)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = {};
    mockPermission = { granted: true };
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as any);
    (apiMock.listItems as jest.Mock).mockResolvedValue({ items: [ITEM, ITEM2, SIZED], total: 3, page: 1, per_page: 100, pages: 1 });
    (apiMock.createSaleOrder as jest.Mock).mockResolvedValue(ORDER);
    (apiMock.getMe as jest.Mock).mockResolvedValue({ business_name: 'Kicks Co', sales_tax_rate: null });
    (apiMock.updateProfile as jest.Mock).mockResolvedValue({});
  });

  afterEach(() => jest.restoreAllMocks());

  it('has no duplicate in-page title (the nav header says Quick Sale)', async () => {
    const screen = await ready();
    expect(screen.queryByText('Quick Sale')).toBeNull();
  });

  it('logs the whole cart as ONE order and shows a shareable receipt', async () => {
    const screen = await ready();
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.press(screen.getByText('Sony WH-1000XM5'));
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
    await screen.findByText('Sale complete');
    fireEvent.press(screen.getByText('Share receipt'));
    await waitFor(() => expect(Share.share).toHaveBeenCalled());
    const message = (Share.share as jest.Mock).mock.calls[0][0].message as string;
    expect(message).toContain('Kicks Co');
    expect(message).toContain('Total  $550.00');
    expect(message).toContain('Paid Cash  $550.00');

    fireEvent.press(screen.getByText('Done'));
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
  });

  it('starts a new sale from the receipt', async () => {
    const screen = await ready();
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.press(screen.getByText(/Log Sale/));
    await screen.findByText('Sale complete');
    fireEvent.press(screen.getByText('New sale'));
    await waitFor(() => expect(screen.queryByText(/Cart ·/)).toBeNull());
    expect(apiMock.listItems).toHaveBeenCalledTimes(2);
  });

  it('adjusts line quantity and applies card + fee', async () => {
    const screen = await ready();
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.press(screen.getByLabelText('Increase Jordan 1 Retro High'));
    fireEvent.press(screen.getByLabelText('Increase Jordan 1 Retro High'));
    fireEvent.press(screen.getByLabelText('Decrease Jordan 1 Retro High'));
    fireEvent.press(screen.getByLabelText('Pay with Card'));
    fireEvent.changeText(screen.getByLabelText('Fee amount'), '5');
    fireEvent.press(screen.getByText(/Log Sale/));
    await waitFor(() =>
      expect(apiMock.createSaleOrder).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'card', fee_amount: '5.00', lines: [{ item_id: 'item-1', quantity: 2, unit_price: '340.00' }] }),
      ),
    );
  });

  it('offers the other methods as chips', async () => {
    const screen = await ready();
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.press(screen.getByText('PayPal'));
    fireEvent.press(screen.getByText(/Log Sale/));
    await waitFor(() => expect(apiMock.createSaleOrder).toHaveBeenCalledWith(expect.objectContaining({ method: 'paypal' })));
  });

  it('lets the seller haggle the price per line', async () => {
    const screen = await ready();
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

  it('applies a dollar or percent discount and validates it', async () => {
    const screen = await ready();
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.changeText(screen.getByLabelText('Discount'), '400');
    expect(screen.getByText("The discount can't be more than the subtotal.")).toBeTruthy();
    fireEvent.press(screen.getByText(/Log Sale/));
    expect(Alert.alert).toHaveBeenLastCalledWith('Check the discount', "The discount can't be more than the subtotal.");

    fireEvent.changeText(screen.getByLabelText('Discount'), '40');
    expect(screen.getByText(/Log Sale · \$300\.00/)).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Discount in percent'));
    fireEvent.changeText(screen.getByLabelText('Discount'), '10');
    expect(screen.getByText(/Log Sale · \$306\.00/)).toBeTruthy();
    fireEvent.press(screen.getByText(/Log Sale/));
    await waitFor(() => expect(apiMock.createSaleOrder).toHaveBeenCalledWith(expect.objectContaining({ discount_percent: '10' })));

    fireEvent.press(screen.getByText('New sale'));
    fireEvent.press(await screen.findByText('Jordan 1 Retro High'));
    fireEvent.press(screen.getByLabelText('Discount in dollars'));
    fireEvent.changeText(screen.getByLabelText('Discount'), '40');
    fireEvent.press(screen.getByText(/Log Sale/));
    await waitFor(() => expect(apiMock.createSaleOrder).toHaveBeenLastCalledWith(expect.objectContaining({ discount_amount: '40.00' })));
  });

  it('charges sales tax from the seller default and can save a new default', async () => {
    (apiMock.getMe as jest.Mock).mockResolvedValue({ business_name: null, sales_tax_rate: '6.625' });
    const screen = await ready();
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    await waitFor(() => expect(screen.getByText(/Log Sale · \$362\.53/)).toBeTruthy());
    expect(screen.getByText('Tax (6.625%)')).toBeTruthy();

    fireEvent.changeText(screen.getByLabelText('Sales tax rate'), '7');
    fireEvent.press(screen.getByText('Use 7% for every sale'));
    await waitFor(() => expect(apiMock.updateProfile).toHaveBeenCalledWith({ sales_tax_rate: '7' }));
    await waitFor(() => expect(screen.queryByText('Use 7% for every sale')).toBeNull());

    fireEvent.press(screen.getByText(/Log Sale/));
    await waitFor(() => expect(apiMock.createSaleOrder).toHaveBeenCalledWith(expect.objectContaining({ tax_rate: '7' })));
  });

  it('reports a failed default-tax save and can turn tax off per sale', async () => {
    (apiMock.updateProfile as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    const screen = await ready();
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.press(screen.getByLabelText('Charge sales tax'));
    fireEvent.changeText(screen.getByLabelText('Sales tax rate'), '5');
    expect(screen.getByText(/Log Sale · \$357\.00/)).toBeTruthy();
    fireEvent.press(screen.getByText('Use 5% for every sale'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith("Couldn't save", 'offline'));
    fireEvent.press(screen.getByLabelText('Charge sales tax'));
    expect(screen.getByText(/Log Sale · \$340\.00/)).toBeTruthy();
  });

  it('splits a payment across cash and card and requires an exact total', async () => {
    const screen = await ready();
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.press(screen.getByLabelText('Split payment'));
    expect(screen.getByText('Paid in full · $340.00')).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText('Payment 1 amount'), '200');
    fireEvent.changeText(screen.getByLabelText('Payment 2 amount'), '100');
    expect(screen.getByText('$40.00 left to pay')).toBeTruthy();
    fireEvent.press(screen.getByText(/Log Sale/));
    expect(Alert.alert).toHaveBeenLastCalledWith('Payments don\'t add up', expect.stringContaining('$40.00 is still unpaid'));

    fireEvent.press(screen.getByText('Make this $140.00'));
    fireEvent.press(screen.getByLabelText('Payment 2 Venmo'));
    fireEvent.press(screen.getByText(/Log Sale/));
    await waitFor(() =>
      expect(apiMock.createSaleOrder).toHaveBeenCalledWith(expect.objectContaining({
        payments: [{ method: 'cash', amount: '200.00' }, { method: 'venmo', amount: '140.00' }],
      })),
    );
    expect((apiMock.createSaleOrder as jest.Mock).mock.calls[0][0].method).toBeUndefined();
    await screen.findByText('Paid · Venmo');
  });

  it('adds and removes split rows and flags overpayment', async () => {
    const screen = await ready();
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.press(screen.getByLabelText('Split payment'));
    fireEvent.changeText(screen.getByLabelText('Payment 1 amount'), '300');
    fireEvent.changeText(screen.getByLabelText('Payment 2 amount'), '100');
    expect(screen.getByText('$60.00 over the total')).toBeTruthy();
    fireEvent.press(screen.getByText(/Log Sale/));
    expect(Alert.alert).toHaveBeenLastCalledWith('Payments don\'t add up', expect.stringContaining('$60.00 over'));
    fireEvent.changeText(screen.getByLabelText('Payment 2 amount'), '20');
    fireEvent.press(screen.getByLabelText('Add payment'));
    expect(screen.getByLabelText('Payment 3 amount').props.value).toBe('20.00');
    fireEvent.press(screen.getByLabelText('Remove payment 3'));
    expect(screen.queryByLabelText('Payment 3 amount')).toBeNull();
    fireEvent.press(screen.getByLabelText('Remove payment 2'));
    expect(screen.queryByLabelText('Payment 1 amount')).toBeNull();
    fireEvent.press(screen.getByLabelText('Split payment'));
    fireEvent.press(screen.getByText('One payment'));
    expect(screen.getByLabelText('Pay with Cash')).toBeTruthy();
  });

  it('requires a size for items with size variants and sends it', async () => {
    const screen = await ready();
    fireEvent.press(screen.getByText('Dunk Low Panda'));
    fireEvent.press(screen.getByText(/Log Sale/));
    expect(Alert.alert).toHaveBeenLastCalledWith('Pick a size', 'Choose which size of Dunk Low Panda you sold.');
    fireEvent.press(screen.getByLabelText('Size 10.5, 2 in stock'));
    fireEvent.press(screen.getByLabelText('Increase Dunk Low Panda'));
    fireEvent.press(screen.getByLabelText('Increase Dunk Low Panda')); // capped at 2 for size 10.5
    fireEvent.press(screen.getByLabelText('Size 9, 1 in stock')); // qty clamps to 1
    fireEvent.press(screen.getByText(/Log Sale/));
    await waitFor(() =>
      expect(apiMock.createSaleOrder).toHaveBeenCalledWith(expect.objectContaining({
        lines: [{ item_id: 'item-3', quantity: 1, unit_price: '120.00', size: '9' }],
      })),
    );
    await screen.findByText(/Size 9/);
  });

  it('scans a barcode to add the item, and explains unknown codes', async () => {
    const screen = await ready();
    fireEvent.press(screen.getByLabelText('Scan barcode to add'));
    await waitFor(() => expect(mockOnScan).toBeDefined());
    await act(async () => mockOnScan!({ data: '12345678905' })); // EAN/UPC leading zero
    expect(screen.getByText(/Cart · 1 item/)).toBeTruthy();

    (apiMock.listItems as jest.Mock).mockResolvedValueOnce({ items: [], total: 0, page: 1, per_page: 5, pages: 0 });
    fireEvent.press(screen.getByLabelText('Scan barcode to add'));
    await act(async () => mockOnScan!({ data: '999' }));
    expect(apiMock.listItems).toHaveBeenLastCalledWith({ upc: '999', perPage: 5, availableOnly: true });
    const [title, , buttons] = (Alert.alert as jest.Mock).mock.calls.at(-1);
    expect(title).toBe('Not in your inventory');
    buttons[1].onPress();
    expect(mockPush).toHaveBeenCalledWith('/inventory/add');
  });

  it('finds scanned items on the server when not loaded, and survives lookup errors', async () => {
    const FAR = { ...ITEM2, id: 'item-9', name: 'Far Item', upc: '777' };
    const screen = await ready();
    (apiMock.listItems as jest.Mock).mockResolvedValueOnce({ items: [FAR], total: 1, page: 1, per_page: 5, pages: 1 });
    fireEvent.press(screen.getByLabelText('Scan barcode to add'));
    await act(async () => mockOnScan!({ data: '777' }));
    expect(screen.getByLabelText('Remove Far Item')).toBeTruthy();

    (apiMock.listItems as jest.Mock).mockRejectedValueOnce(new Error('down'));
    fireEvent.press(screen.getByLabelText('Scan barcode to add'));
    await act(async () => mockOnScan!({ data: '555' }));
    expect(Alert.alert).toHaveBeenLastCalledWith('Not in your inventory', expect.any(String), expect.any(Array));
  });

  it('asks for camera permission before scanning', async () => {
    mockPermission = { granted: false };
    const screen = await ready();
    fireEvent.press(screen.getByLabelText('Scan barcode to add'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Camera needed', expect.any(String)));
    mockRequestPermission.mockResolvedValueOnce({ granted: true });
    fireEvent.press(screen.getByLabelText('Scan barcode to add'));
    await waitFor(() => expect(screen.getByTestId('camera-view')).toBeTruthy());
  });

  it('prefills the cart from a "sell this" link', async () => {
    mockParams = { add: 'item-2' };
    const screen = await ready();
    await waitFor(() => expect(screen.getByLabelText('Remove Sony WH-1000XM5')).toBeTruthy());
  });

  it('rejects a fee larger than the sale', async () => {
    const screen = await ready();
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.changeText(screen.getByLabelText('Fee amount'), '999');
    fireEvent.press(screen.getByText(/Log Sale/));
    expect(Alert.alert).toHaveBeenLastCalledWith('Check the fee', "The fee can't be more than the sale total.");
    expect(apiMock.createSaleOrder).not.toHaveBeenCalled();
  });

  it('says when the order was saved offline', async () => {
    (apiMock.createSaleOrder as jest.Mock).mockResolvedValueOnce({ ...ORDER, pending: true });
    const screen = await ready();
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.press(screen.getByText(/Log Sale/));
    await screen.findByText('Sale saved offline');
  });

  it('blocks logging with an empty cart', async () => {
    const screen = await ready();
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

    const screen = await ready();
    fireEvent.changeText(screen.getByLabelText('Search sale inventory'), 'sony');
    expect(screen.queryByText('Jordan 1 Retro High')).toBeNull();
    expect(screen.getByText('Sony WH-1000XM5')).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText('Search sale inventory'), 'zzz');
    expect(screen.getByText('No sellable items match that search.')).toBeTruthy();
  });

  it('reports transaction failures', async () => {
    (apiMock.createSaleOrder as jest.Mock).mockRejectedValueOnce(new Error('payment down'));
    const screen = await ready();
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.press(screen.getByText(/Log Sale/));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Sale failed', 'payment down'));
  });

  it('opens the end-of-show summary', async () => {
    const screen = await ready();
    fireEvent.press(screen.getByText('End-of-show summary'));
    expect(mockPush).toHaveBeenCalledWith('/settings/show-summary');
  });
});
