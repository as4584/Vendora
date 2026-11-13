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
  getItem: jest.fn(),
  listCustomers: jest.fn(),
  createSaleOrder: jest.fn(),
  refundTransaction: jest.fn(),
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
    (apiMock.getItem as jest.Mock).mockResolvedValue(ITEM2);
    (apiMock.listCustomers as jest.Mock).mockResolvedValue([]);
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
      client_request_id: expect.any(String),
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

  it('clears the previous customer and restores the saved tax and cash defaults', async () => {
    (apiMock.getMe as jest.Mock).mockResolvedValue({ business_name: null, sales_tax_rate: '6' });
    (apiMock.listCustomers as jest.Mock).mockResolvedValue([{ id: 'buyer-1', name: 'Test Buyer' }]);
    const screen = await ready();
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.press(screen.getByText('Pick customer'));
    fireEvent.press(await screen.findByLabelText('Pick Test Buyer'));
    fireEvent.changeText(screen.getByLabelText('Sales tax rate'), '9');
    fireEvent.press(screen.getByLabelText('Pay with Card'));
    fireEvent.press(screen.getByText(/Log Sale/));
    await screen.findByText('Sale complete');
    expect(apiMock.createSaleOrder).toHaveBeenLastCalledWith(expect.objectContaining({
      customer_id: 'buyer-1', tax_rate: '9', method: 'card',
    }));
    fireEvent.press(screen.getByText('New sale'));
    fireEvent.press(await screen.findByText('Jordan 1 Retro High'));
    expect(screen.queryByText('Test Buyer')).toBeNull();
    expect(screen.getByLabelText('Sales tax rate').props.value).toBe('6');
    fireEvent.press(screen.getByText(/Log Sale/));
    await waitFor(() => expect(apiMock.createSaleOrder).toHaveBeenCalledTimes(2));
    const nextOrder = (apiMock.createSaleOrder as jest.Mock).mock.calls[1][0];
    expect(nextOrder).toMatchObject({ tax_rate: '6', method: 'cash' });
    expect(nextOrder).not.toHaveProperty('customer_id');
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

  it('haggles with one tap: -$5, -$10, -10%, back to list', async () => {
    const screen = await ready();
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    const price = () => screen.getByLabelText('Sale price for Jordan 1 Retro High').props.value;
    fireEvent.press(screen.getByLabelText('-$10 on Jordan 1 Retro High'));
    expect(price()).toBe('330.00');
    fireEvent.press(screen.getByLabelText('-$5 on Jordan 1 Retro High'));
    expect(price()).toBe('325.00');
    fireEvent.press(screen.getByLabelText('-10% on Jordan 1 Retro High'));
    expect(price()).toBe('293.00');
    fireEvent.press(screen.getByLabelText('List on Jordan 1 Retro High'));
    expect(price()).toBe('340.00');
  });

  it('undoes a cash sale right after it is logged', async () => {
    (apiMock.createSaleOrder as jest.Mock).mockResolvedValue({ ...ORDER, transactions: [{ id: 't1' }] });
    (apiMock.refundTransaction as jest.Mock).mockRejectedValueOnce(new Error('server busy')).mockResolvedValue({});
    const pressConfirm = () => {
      const buttons = (Alert.alert as jest.Mock).mock.calls.at(-1)[2];
      return buttons.find((b: { text: string }) => b.text === 'Undo sale').onPress();
    };
    const screen = await ready();
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.press(screen.getByText(/Log Sale/));
    await screen.findByText('Sale complete');

    fireEvent.press(screen.getByTestId('undo-sale'));
    await act(async () => { await pressConfirm(); });
    expect(Alert.alert).toHaveBeenLastCalledWith("Couldn't undo", 'server busy');

    fireEvent.press(screen.getByTestId('undo-sale'));
    await act(async () => { await pressConfirm(); });
    expect(apiMock.refundTransaction).toHaveBeenLastCalledWith('t1', 'Undone at checkout');
    expect(Alert.alert).toHaveBeenLastCalledWith('Sale undone', 'Items are back in stock.');
    await waitFor(() => expect(screen.queryByText('Sale complete')).toBeNull());
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
    await screen.findByText('Size 9 · 1 x $120.00');
  });

  it('sells multiple sizes of the same item with independent prices and stock caps', async () => {
    const screen = await ready();
    fireEvent.press(screen.getByText('Dunk Low Panda'));
    fireEvent.press(screen.getByLabelText('Size 9, 1 in stock'));
    fireEvent.press(screen.getByText('Add another size'));
    fireEvent.press(screen.getByLabelText('Increase Dunk Low Panda, size 9'));
    fireEvent.press(screen.getByLabelText('Increase Dunk Low Panda, size 10.5'));
    fireEvent.press(screen.getByLabelText('Increase Dunk Low Panda, size 10.5'));
    fireEvent.changeText(screen.getByLabelText('Sale price for Dunk Low Panda, size 10.5'), '110');
    fireEvent.press(screen.getByText(/Log Sale/));
    await waitFor(() => expect(apiMock.createSaleOrder).toHaveBeenCalledWith(expect.objectContaining({
      lines: [
        { item_id: 'item-3', quantity: 1, unit_price: '120.00', size: '9' },
        { item_id: 'item-3', quantity: 2, unit_price: '110.00', size: '10.5' },
      ],
    })));
    await screen.findByText('Sale complete');
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
    expect(screen.getByLabelText('Remove Far Item from cart')).toBeTruthy();

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

  it('prefills the cart from a "sell this" link outside the first page', async () => {
    mockParams = { add: 'item-1001' };
    (apiMock.getItem as jest.Mock).mockResolvedValue({ ...ITEM2, id: 'item-1001', name: 'Older stock' });
    const screen = await ready();
    await waitFor(() => expect(screen.getByLabelText('Remove Older stock from cart')).toBeTruthy());
    expect(apiMock.getItem).toHaveBeenCalledWith('item-1001');
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
    await failed.findByText("Couldn't load your stock. Try again.");
    expect(failed.queryByText("Table's empty — add stock to start a sale.")).toBeNull();
    fireEvent.press(failed.getByText('Try loading stock again'));
    await failed.findByText('Jordan 1 Retro High');
    expect(failed.queryByText("Couldn't load your stock. Try again.")).toBeNull();
    failed.unmount();

    const screen = await ready();
    (apiMock.listItems as jest.Mock)
      .mockResolvedValueOnce({ items: [ITEM2], pages: 1 })
      .mockResolvedValueOnce({ items: [], pages: 0 });
    fireEvent.changeText(screen.getByLabelText('Search sale inventory'), 'sony');
    expect(screen.queryByText('Jordan 1 Retro High')).toBeNull();
    expect(await screen.findByText('Sony WH-1000XM5')).toBeTruthy();
    expect(apiMock.listItems).toHaveBeenLastCalledWith({ perPage: 12, availableOnly: true, q: 'sony' });
    fireEvent.changeText(screen.getByLabelText('Search sale inventory'), 'zzz');
    expect(await screen.findByText('No sellable items match that search.')).toBeTruthy();
    fireEvent.press(screen.getByText('Clear search'));
    expect(await screen.findByText('Jordan 1 Retro High')).toBeTruthy();
    expect(screen.getByLabelText('Search sale inventory').props.value).toBe('');
  });

  it('loads later pages and retries a page without clearing earlier stock', async () => {
    const FAR = { ...ITEM2, id: 'item-1001', name: 'Older stock' };
    (apiMock.listItems as jest.Mock)
      .mockResolvedValueOnce({ items: [ITEM], pages: 2 })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [FAR], pages: 2 });
    const screen = await ready();
    fireEvent.press(screen.getByText('Show more stock'));
    fireEvent.press(await screen.findByText('Retry loading more stock'));
    expect(screen.getByText('Jordan 1 Retro High')).toBeTruthy();
    await screen.findByText('Older stock');
    expect(apiMock.listItems).toHaveBeenLastCalledWith({ perPage: 12, availableOnly: true, page: 2 });
  });

  it('ignores an earlier inventory search that resolves after the latest one', async () => {
    const FAR = { ...ITEM2, id: 'item-1001', name: 'Older stock' };
    let resolveEarlier!: (value: unknown) => void;
    const screen = await ready();
    (apiMock.listItems as jest.Mock)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveEarlier = resolve; }))
      .mockResolvedValueOnce({ items: [FAR], pages: 1 });
    fireEvent.changeText(screen.getByLabelText('Search sale inventory'), 'first search');
    await waitFor(() => expect(resolveEarlier).toBeDefined());
    fireEvent.changeText(screen.getByLabelText('Search sale inventory'), 'Older stock');
    await screen.findByText('Older stock');
    await act(async () => resolveEarlier({ items: [ITEM], pages: 1 }));
    expect(screen.queryByText('Jordan 1 Retro High')).toBeNull();
    expect(screen.getByText('Older stock')).toBeTruthy();
  });

  it('offers Add stock when inventory is genuinely empty', async () => {
    (apiMock.listItems as jest.Mock).mockResolvedValueOnce({ items: [], total: 0 });
    const screen = render(<QuickSaleScreen />);
    await screen.findByText("Table's empty — add stock to start a sale.");
    expect(screen.queryByText('No sellable items match that search.')).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Add stock' }));
    expect(mockPush).toHaveBeenCalledWith('/inventory/add');
  });

  it('shows a named loading state without empty-state actions while pending', async () => {
    let resolve!: (value: unknown) => void;
    (apiMock.listItems as jest.Mock).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const screen = render(<QuickSaleScreen />);
    expect(screen.getByLabelText('Loading sellable inventory')).toBeTruthy();
    expect(screen.queryByText("Table's empty — add stock to start a sale.")).toBeNull();
    await waitFor(() => expect(resolve).toBeDefined());
    await act(async () => resolve({ items: [ITEM] }));
    expect(screen.queryByLabelText('Loading sellable inventory')).toBeNull();
    expect(screen.getByText('Jordan 1 Retro High')).toBeTruthy();
  });

  it('reports transaction failures', async () => {
    (apiMock.createSaleOrder as jest.Mock).mockRejectedValueOnce(new Error('payment down'));
    const screen = await ready();
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.press(screen.getByText(/Log Sale/));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Sale failed', 'payment down'));
  });

  it('reuses the sale key for an unchanged retry and changes it for an edited order', async () => {
    (apiMock.createSaleOrder as jest.Mock)
      .mockRejectedValueOnce(new Error('response lost'))
      .mockRejectedValueOnce(new Error('try again'));
    const screen = await ready();
    fireEvent.press(screen.getByText('Jordan 1 Retro High'));
    fireEvent.press(screen.getByText(/Log Sale/));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Sale failed', 'response lost'));
    fireEvent.press(screen.getByText(/Log Sale/));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Sale failed', 'try again'));
    fireEvent.changeText(screen.getByLabelText('Sale price for Jordan 1 Retro High'), '300');
    fireEvent.press(screen.getByText(/Log Sale/));
    await screen.findByText('Sale complete');

    const [first, retry, edited] = (apiMock.createSaleOrder as jest.Mock).mock.calls.map(([payload]) => payload);
    expect(first.client_request_id).toEqual(expect.any(String));
    expect(retry).toEqual(first);
    expect(edited.client_request_id).not.toEqual(first.client_request_id);
    expect(edited.lines[0].unit_price).toBe('300.00');
  });

  it('opens the end-of-show summary', async () => {
    const screen = await ready();
    fireEvent.press(screen.getByText('End-of-show summary'));
    expect(mockPush).toHaveBeenCalledWith('/settings/show-summary');
  });
});
