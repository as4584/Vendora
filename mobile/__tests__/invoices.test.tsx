import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import * as fileActionsMock from '../utils/fileActions';
import InvoicesScreen from '../app/(tabs)/inventory/invoices';

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
  listInvoices: jest.fn(),
  listItems: jest.fn(),
  createInvoice: jest.fn(),
  exportInvoicePdf: jest.fn(),
}));

jest.mock('../utils/fileActions', () => ({
  previewPdfFile: jest.fn(),
  downloadPdfFile: jest.fn(),
}));

const INVENTORY_ITEM = {
  id: 'item-1',
  user_id: 'user-1',
  name: 'Jordan 1 Retro High',
  category: 'Sneakers',
  sku: 'AJ1-001',
  upc: null,
  size: '10',
  color: 'Bred',
  condition: 'New',
  serial_number: null,
  custom_attributes: {
    variants: [
      { size: '9', quantity: 1 },
      { size: '10', quantity: 1 },
    ],
  },
  buy_price: '150.00',
  expected_sell_price: '340.00',
  actual_sell_price: null,
  platform: 'StockX',
  status: 'in_stock',
  photo_front_url: null,
  photo_back_url: null,
  quantity: 2,
  vendor_name: 'Kick Game Supply',
  notes: null,
  source: 'manual',
  external_id: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const CREATED_INVOICE = {
  id: 'inv-1',
  customer_name: 'Alex',
  customer_email: 'alex@example.com',
  status: 'draft',
  subtotal: '340.00',
  tax: '0.00',
  shipping: '0.00',
  discount: '0.00',
  total: '340.00',
  notes: null,
  items: [
    {
      id: 'line-1',
      description: 'Jordan 1 Retro High',
      quantity: 1,
      unit_price: '340.00',
      line_total: '340.00',
      inventory_item_id: 'item-1',
      size_label: '10',
    },
  ],
  created_at: '2026-04-25T12:00:00Z',
  updated_at: '2026-04-25T12:00:00Z',
};

describe('InvoicesScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    (apiMock.listInvoices as jest.Mock).mockResolvedValue({
      items: [CREATED_INVOICE],
      total: 1,
      page: 1,
      per_page: 20,
      pages: 1,
    });
    (apiMock.listItems as jest.Mock).mockResolvedValue({
      items: [INVENTORY_ITEM],
      total: 1,
      page: 1,
      per_page: 60,
      pages: 1,
    });
    (apiMock.createInvoice as jest.Mock).mockResolvedValue(CREATED_INVOICE);
    (apiMock.exportInvoicePdf as jest.Mock).mockResolvedValue({
      pdf_base64: 'JVBERi0xLjQK',
      filename: 'invoice-0001.pdf',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates an invoice directly from inventory without leaving a blank draft row behind', async () => {
    const screen = render(<InvoicesScreen />);

    await waitFor(() => {
      expect(screen.getByText('From Inventory')).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.getByText('9')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('10'));
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue('Jordan 1 Retro High - Size 10')).toBeTruthy();
      expect(screen.getAllByText('From Inventory').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Jordan 1 Retro High size 10 was added to the invoice below.')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Customer Name'), 'Alex');
    });

    await act(async () => {
      fireEvent.press(screen.getAllByText('Create Invoice').slice(-1)[0]);
    });

    await waitFor(() => {
      expect(apiMock.createInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          customer_name: 'Alex',
          items: [
            expect.objectContaining({
              description: 'Jordan 1 Retro High - Size 10',
              inventory_item_id: 'item-1',
              size_label: '10',
            }),
          ],
        }),
      );
    });
  });

  it('searches inventory from the server and labels invoice totals clearly', async () => {
    const screen = render(<InvoicesScreen />);

    await waitFor(() => {
      expect(screen.getByText('From Inventory')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Search by item name, SKU, or category'), 'jordan');
      await new Promise((resolve) => setTimeout(resolve, 450));
    });

    await waitFor(() => {
      expect(apiMock.listItems).toHaveBeenCalledWith({
        perPage: 20,
        availableOnly: true,
        q: 'jordan',
      });
    });

    expect(screen.getByText('Sales tax')).toBeTruthy();
    expect(screen.getByText('Shipping charged')).toBeTruthy();
    expect(screen.getByText('Discount or credit')).toBeTruthy();
  });

  it('opens a saved invoice preview from history and can download its PDF', async () => {
    const screen = render(<InvoicesScreen />);

    await waitFor(() => {
      expect(screen.getByText('Recent Invoices')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Recent Invoices'));
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Open Invoice'));
    });

    await waitFor(() => {
      expect(screen.getByText('Close Preview')).toBeTruthy();
      expect(screen.getByText('Preview PDF')).toBeTruthy();
      expect(screen.getByText('Download PDF')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Preview PDF'));
    });

    await waitFor(() => {
      expect(apiMock.exportInvoicePdf).toHaveBeenCalledWith('inv-1');
      expect(fileActionsMock.previewPdfFile).toHaveBeenCalledWith('JVBERi0xLjQK', 'invoice-0001.pdf');
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Download PDF'));
    });

    await waitFor(() => {
      expect(apiMock.exportInvoicePdf).toHaveBeenCalledWith('inv-1');
      expect(fileActionsMock.downloadPdfFile).toHaveBeenCalledWith('JVBERi0xLjQK', 'invoice-0001.pdf');
    });

    fireEvent.press(screen.getByText('Create Invoice'));
    expect(screen.getByText('Customer')).toBeTruthy();
  });

  it('lets users leave the invoice screen with the close button', async () => {
    const screen = render(<InvoicesScreen />);

    await waitFor(() => {
      expect(screen.getByText('X')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('X'));
    });

    expect(mockReplace).toHaveBeenCalledWith('/dashboard');
  });

  it('reports initial load and server-side inventory search failures', async () => {
    (apiMock.listInvoices as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    const failed = render(<InvoicesScreen />);
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'Invoices unavailable',
        'Could not load invoices or inventory.',
      ),
    );
    failed.unmount();

    (apiMock.listInvoices as jest.Mock).mockResolvedValueOnce({ items: [] });
    (apiMock.listItems as jest.Mock)
      .mockResolvedValueOnce({ items: [INVENTORY_ITEM] })
      .mockRejectedValueOnce(new Error('search down'));
    const screen = render(<InvoicesScreen />);
    await screen.findByText('From Inventory');
    fireEvent.changeText(screen.getByLabelText('Search invoice inventory'), 'missing');
    await waitFor(
      () =>
        expect(Alert.alert).toHaveBeenCalledWith(
          'Inventory search failed',
          'Could not search your inventory.',
        ),
      { timeout: 1500 },
    );
  });

  it('validates customer and line-item requirements', async () => {
    const screen = render(<InvoicesScreen />);
    await screen.findByText('From Inventory');
    fireEvent.press(screen.getAllByText('Create Invoice').slice(-1)[0]);
    expect(Alert.alert).toHaveBeenLastCalledWith(
      'Customer required',
      'Add a customer name before creating the invoice.',
    );
    fireEvent.changeText(screen.getByLabelText('Customer Name'), 'Alex');
    fireEvent.press(screen.getAllByText('Create Invoice').slice(-1)[0]);
    expect(Alert.alert).toHaveBeenLastCalledWith(
      'Line items required',
      'Each invoice row needs a description and a unit price.',
    );
  });

  it('creates a multi-line custom invoice with adjustments and normalized quantities', async () => {
    const customInvoice = {
      ...CREATED_INVOICE,
      id: 'inv-custom',
      customer_name: '  Taylor  ',
      total: '34.00',
    };
    (apiMock.createInvoice as jest.Mock).mockResolvedValueOnce(customInvoice);
    const screen = render(<InvoicesScreen />);
    await screen.findByText('From Inventory');
    fireEvent.changeText(screen.getByLabelText('Customer Name'), '  Taylor  ');
    fireEvent.changeText(screen.getByLabelText('Customer Email'), ' taylor@example.com ');
    fireEvent.changeText(screen.getByLabelText('Line item 1 description'), ' Service ');
    fireEvent.changeText(screen.getByLabelText('Line item 1 quantity'), '0');
    fireEvent.changeText(screen.getByLabelText('Line item 1 unit price'), ' 20 ');
    fireEvent.press(screen.getByText('Add Custom Item'));
    fireEvent.changeText(screen.getByLabelText('Line item 2 description'), 'Shipping Box');
    fireEvent.changeText(screen.getByLabelText('Line item 2 quantity'), '2');
    fireEvent.changeText(screen.getByLabelText('Line item 2 unit price'), '5');
    fireEvent.changeText(screen.getByLabelText('Sales tax'), '2');
    fireEvent.changeText(screen.getByLabelText('Shipping charged'), '3');
    fireEvent.changeText(screen.getByLabelText('Discount or credit'), '1');
    fireEvent.changeText(screen.getByLabelText('Invoice notes'), ' Thank you ');

    const View = require('react-native').View;
    const anchor = screen.UNSAFE_getAllByType(View).find((node) => node.props.onLayout);
    act(() => anchor?.props.onLayout({ nativeEvent: { layout: { y: 200 } } }));
    fireEvent.press(screen.getAllByText('Create Invoice').slice(-1)[0]);
    await waitFor(() => expect(apiMock.createInvoice).toHaveBeenCalledTimes(1));
    expect(apiMock.createInvoice).toHaveBeenCalledWith({
      customer_name: 'Taylor',
      customer_email: 'taylor@example.com',
      tax: '2',
      shipping: '3',
      discount: '1',
      notes: 'Thank you',
      items: [
        {
          description: 'Service',
          quantity: 1,
          unit_price: '20',
          inventory_item_id: undefined,
          size_label: undefined,
        },
        {
          description: 'Shipping Box',
          quantity: 2,
          unit_price: '5',
          inventory_item_id: undefined,
          size_label: undefined,
        },
      ],
    });
    expect(screen.getAllByText('Open Invoice').length).toBeGreaterThan(0);
  });

  it('adds a non-variant inventory item and appends it after a custom row', async () => {
    const simpleItem = {
      ...INVENTORY_ITEM,
      id: 'simple-1',
      name: 'Simple Item',
      size: null,
      custom_attributes: null,
      expected_sell_price: null,
      buy_price: '25.00',
    };
    (apiMock.listItems as jest.Mock).mockResolvedValueOnce({ items: [simpleItem] });
    const screen = render(<InvoicesScreen />);
    await screen.findByText('Simple Item');
    fireEvent.changeText(screen.getByLabelText('Line item 1 description'), 'Existing');
    fireEvent.changeText(screen.getByLabelText('Line item 1 unit price'), '5');
    fireEvent.press(screen.getByLabelText('Add Simple Item'));
    await waitFor(() => expect(screen.getByDisplayValue('Simple Item')).toBeTruthy());
    expect(screen.getByDisplayValue('25.00')).toBeTruthy();
    expect(screen.getByText('Simple Item was added to the invoice below.')).toBeTruthy();
  });

  it('reports invoice creation and PDF preparation failures', async () => {
    (apiMock.createInvoice as jest.Mock).mockRejectedValueOnce(new Error('invoice down'));
    const screen = render(<InvoicesScreen />);
    await screen.findByText('From Inventory');
    fireEvent.changeText(screen.getByLabelText('Customer Name'), 'Alex');
    fireEvent.changeText(screen.getByLabelText('Line item 1 description'), 'Service');
    fireEvent.changeText(screen.getByLabelText('Line item 1 unit price'), '20');
    fireEvent.press(screen.getAllByText('Create Invoice').slice(-1)[0]);
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Invoice failed', 'invoice down'));

    fireEvent.press(screen.getByText('Recent Invoices'));
    fireEvent.press(screen.getByText('Open Invoice'));
    (apiMock.exportInvoicePdf as jest.Mock).mockRejectedValueOnce(new Error('PDF down'));
    fireEvent.press(screen.getByText('Preview PDF'));
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith('Invoice unavailable', 'PDF down'),
    );
    fireEvent.press(screen.getByText('Close Preview'));
    expect(screen.queryByText('Preview PDF')).toBeNull();
  });

  it('renders empty, paid, and sent invoice history states', async () => {
    (apiMock.listInvoices as jest.Mock).mockResolvedValueOnce({ items: [] });
    const empty = render(<InvoicesScreen />);
    await empty.findByText('Recent Invoices');
    fireEvent.press(empty.getByText('Recent Invoices'));
    expect(empty.getByText('No invoices have been created yet.')).toBeTruthy();
    empty.unmount();

    (apiMock.listInvoices as jest.Mock).mockResolvedValueOnce({
      items: [
        { ...CREATED_INVOICE, id: 'paid', status: 'paid', customer_email: null },
        { ...CREATED_INVOICE, id: 'sent', status: 'sent' },
      ],
    });
    const history = render(<InvoicesScreen />);
    await history.findByText('Recent Invoices');
    fireEvent.press(history.getByText('Recent Invoices'));
    expect(history.getByText('PAID')).toBeTruthy();
    expect(history.getByText('SENT')).toBeTruthy();
  });
});
