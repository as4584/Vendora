import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import CustomersScreen from '../app/(tabs)/customers/index';
import CustomerDetailScreen from '../app/(tabs)/customers/[id]';

const mockPush = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useLocalSearchParams: () => ({ id: 'c-1' }),
}));

jest.mock('../services/api', () => ({
  listCustomers: jest.fn(),
  getCustomer: jest.fn(),
  updateCustomer: jest.fn(),
}));

const CUSTOMER = {
  id: 'c-1',
  name: 'Marcus Reed',
  email: 'marcus@example.com',
  phone: '2015550148',
  address: null,
  tax_exempt: false,
  notes: null,
  order_count: 2,
  total_spent: '235.00',
  last_purchase_at: '2026-11-01T12:00:00Z',
  created_at: '2026-10-01T12:00:00Z',
};

beforeEach(() => jest.clearAllMocks());

describe('CustomersScreen', () => {
  it('lists customers with totals and opens one', async () => {
    (apiMock.listCustomers as jest.Mock).mockResolvedValue([CUSTOMER]);
    const screen = render(<CustomersScreen />);
    expect(await screen.findByText('Marcus Reed')).toBeTruthy();
    expect(screen.getByText('$235.00')).toBeTruthy();
    expect(screen.getByText(/2 purchases/)).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Open Marcus Reed'));
    expect(mockPush).toHaveBeenCalledWith('/customers/c-1');
  });

  it('shows an empty state and searches', async () => {
    (apiMock.listCustomers as jest.Mock).mockResolvedValue([]);
    const screen = render(<CustomersScreen />);
    expect(await screen.findByText(/No customers yet/)).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText('Search customers'), 'zed');
    await waitFor(() => expect(apiMock.listCustomers).toHaveBeenLastCalledWith('zed'));
    expect(await screen.findByText('No customers match that search.')).toBeTruthy();
  });
});

describe('CustomerDetailScreen', () => {
  it('shows purchase history and saves edits', async () => {
    (apiMock.getCustomer as jest.Mock).mockResolvedValue({
      ...CUSTOMER,
      invoices: [{ id: 'inv-1', invoice_number: 'INV0001', status: 'partially_paid', total: '130.00', amount_paid: '50.00', created_at: '2026-10-02T00:00:00Z' }],
      orders: [{ order_id: 'o-1', transaction_id: 't-1', total: '185.00', item_count: 1, refunded: false, created_at: '2026-11-01T12:00:00Z' }],
    });
    (apiMock.updateCustomer as jest.Mock).mockResolvedValue(CUSTOMER);
    const screen = render(<CustomerDetailScreen />);
    expect(await screen.findByText('Invoice INV0001')).toBeTruthy();
    expect(screen.getByText('Checkout · 1 item')).toBeTruthy();
    expect(screen.getByText('Part paid')).toBeTruthy();
    fireEvent.press(screen.getByText('Edit details'));
    fireEvent(screen.getByLabelText('Tax exempt'), 'valueChange', true);
    await act(async () => { fireEvent.press(screen.getByText('Save')); });
    expect(apiMock.updateCustomer).toHaveBeenCalledWith('c-1', expect.objectContaining({ tax_exempt: true, name: 'Marcus Reed' }));
    fireEvent.press(screen.getByText('New invoice for this customer'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/inventory/invoices', params: { customer: 'c-1' } });
  });
});
