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
  openPdfFile: jest.fn(),
}));

import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import * as fileActionsMock from '../utils/fileActions';
import InvoicesScreen from '../app/(tabs)/inventory/invoices';

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
  custom_attributes: null,
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

    await act(async () => {
      fireEvent.press(screen.getByText('Add'));
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue('Jordan 1 Retro High')).toBeTruthy();
      expect(screen.getAllByText('From Inventory').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Jordan 1 Retro High was added to the invoice below.')).toBeTruthy();
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
              description: 'Jordan 1 Retro High',
              inventory_item_id: 'item-1',
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
      expect(screen.getByText('Download PDF')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Download PDF'));
    });

    await waitFor(() => {
      expect(apiMock.exportInvoicePdf).toHaveBeenCalledWith('inv-1');
      expect(fileActionsMock.openPdfFile).toHaveBeenCalledWith('JVBERi0xLjQK', 'invoice-0001.pdf');
    });
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
});
