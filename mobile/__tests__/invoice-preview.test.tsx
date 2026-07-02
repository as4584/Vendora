import React from 'react';
import { ActivityIndicator } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import InvoicePreviewScreen from '../app/(tabs)/inventory/invoice-preview';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(async () => null), setItem: jest.fn(async () => undefined), removeItem: jest.fn(async () => undefined) },
}));

const mockBack = jest.fn();
let mockParams: Record<string, unknown> = { id: 'inv-1' };
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack }),
  useLocalSearchParams: () => mockParams,
}));

let mockUser: Record<string, unknown> | null = {};
jest.mock('../context/auth', () => ({ useAuth: () => ({ user: mockUser }) }));

jest.mock('../services/api', () => ({ getInvoice: jest.fn() }));

const FULL = {
  id: 'inv-1', customer_name: 'Jane Doe', customer_email: 'jane@example.com',
  created_at: '2026-05-01T00:00:00Z', status: 'sent',
  items: [{ id: 'li-1', description: 'Air Jordan 1', size_label: 'US 9', quantity: 2, unit_price: '100.00', line_total: '200.00' }],
  subtotal: '200.00', tax: '16.00', shipping: '5.00', discount: '10.00', total: '211.00', notes: 'Thank you!',
};

const MIN = {
  id: 'inv-2', customer_name: 'Bob', customer_email: '', created_at: '2026-05-02T00:00:00Z', status: 'paid',
  items: [{ id: 'li-2', description: 'Cap', size_label: '', quantity: 1, unit_price: '20.00', line_total: '20.00' }],
  subtotal: '20.00', tax: '0', shipping: '0', discount: '0', total: '20.00', notes: '',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = { id: 'inv-1' };
  mockUser = {};
});

describe('InvoicePreviewScreen', () => {
  it('renders a full unpaid invoice with all optional fields + branding', async () => {
    mockUser = { business_name: 'Alex Store', email: 'alex@example.com', invoice_accent_color: '#8E6BFF', business_address: '1 Main St', business_phone: '555-1212' };
    (apiMock.getInvoice as jest.Mock).mockResolvedValue(FULL);
    const screen = render(<InvoicePreviewScreen />);
    await screen.findByText('Jane Doe', {}, { timeout: 5000 });
    expect(screen.getByText('Alex Store')).toBeTruthy();
    expect(screen.getByText('1 Main St')).toBeTruthy();
    expect(screen.getByText('555-1212')).toBeTruthy();
    expect(screen.getByText('Air Jordan 1')).toBeTruthy();
    expect(screen.getByText('Size: US 9')).toBeTruthy();
    expect(screen.getByText('Tax')).toBeTruthy();
    expect(screen.getByText('Shipping')).toBeTruthy();
    expect(screen.getByText('Discount')).toBeTruthy();
    expect(screen.getByText('Notes: Thank you!')).toBeTruthy();
    fireEvent.press(screen.getByText('Close'));
    expect(mockBack).toHaveBeenCalled();
  });

  it('renders a paid invoice with no optional fields (email-derived business name, zero balance)', async () => {
    mockUser = { business_name: null, email: 'owner@shop.com' };
    (apiMock.getInvoice as jest.Mock).mockResolvedValue(MIN);
    const screen = render(<InvoicePreviewScreen />);
    await screen.findByText('Bob');
    // Business name derived from the email local-part.
    expect(screen.getByText('owner')).toBeTruthy();
    expect(screen.getByText('BALANCE DUE')).toBeTruthy();
    // No tax/shipping/discount/notes rows for the minimal invoice.
    expect(screen.queryByText('Tax')).toBeNull();
    expect(screen.queryByText('Shipping')).toBeNull();
    expect(screen.queryByText(/^Notes:/)).toBeNull();
  });

  it('shows a not-found view and closes on Back when the invoice fails to load', async () => {
    (apiMock.getInvoice as jest.Mock).mockRejectedValue(new Error('gone'));
    const screen = render(<InvoicePreviewScreen />);
    await screen.findByText('Invoice not found.');
    fireEvent.press(screen.getByText('Back'));
    expect(mockBack).toHaveBeenCalled();
  });

  it('stays on the loader and skips the request when no id is provided', async () => {
    mockParams = {};
    const screen = render(<InvoicePreviewScreen />);
    expect(screen.UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
    await waitFor(() => expect(apiMock.getInvoice).not.toHaveBeenCalled());
  });

  it('falls back to a default business name when neither name nor email exist', async () => {
    mockUser = {};
    (apiMock.getInvoice as jest.Mock).mockResolvedValue(FULL);
    const screen = render(<InvoicePreviewScreen />);
    await screen.findByText('Your Business');
  });
});
