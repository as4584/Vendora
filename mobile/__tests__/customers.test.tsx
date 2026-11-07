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

  it('validates, cancels and reports save and load failures', async () => {
    const { Alert } = require('react-native');
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    (apiMock.getCustomer as jest.Mock).mockResolvedValue({ ...CUSTOMER, email: null, phone: null, tax_exempt: true, address: '1 Main', notes: 'VIP', invoices: [], orders: [
      { order_id: null, transaction_id: 't-9', total: '50.00', item_count: 2, refunded: true, created_at: '2026-11-01T12:00:00Z' },
    ] });
    (apiMock.updateCustomer as jest.Mock).mockRejectedValueOnce(new Error('save down'));
    const screen = render(<CustomerDetailScreen />);
    expect(await screen.findByText('Refunded')).toBeTruthy();
    expect(screen.getByText('No contact details')).toBeTruthy();
    expect(screen.getByText('VIP')).toBeTruthy();
    fireEvent.press(screen.getByText('Edit details'));
    for (const label of ['Email', 'Phone', 'Address', 'Notes']) fireEvent.changeText(screen.getByLabelText(label), 'x');
    fireEvent.changeText(screen.getByLabelText('Name'), '  ');
    await act(async () => { fireEvent.press(screen.getByText('Save')); });
    expect(alertSpy).toHaveBeenCalledWith('Name required', 'A customer needs a name.');
    fireEvent.changeText(screen.getByLabelText('Name'), 'Marcus');
    await act(async () => { fireEvent.press(screen.getByText('Save')); });
    expect(alertSpy).toHaveBeenCalledWith('Save failed', 'save down');
    fireEvent.press(screen.getByText('Cancel'));
    expect(screen.getByText('Edit details')).toBeTruthy();
    screen.unmount();

    (apiMock.getCustomer as jest.Mock).mockRejectedValueOnce(new Error('gone'));
    const failed = render(<CustomerDetailScreen />);
    expect(await failed.findByText('gone')).toBeTruthy();
    alertSpy.mockRestore();
  });
});

describe('CustomersScreen errors', () => {
  it('shows a load error and refreshes', async () => {
    (apiMock.listCustomers as jest.Mock).mockRejectedValueOnce(new Error('list down')).mockResolvedValue([CUSTOMER]);
    const screen = render(<CustomersScreen />);
    expect(await screen.findByText('list down')).toBeTruthy();
    await act(async () => { screen.getByTestId('customers-content').props.refreshControl.props.onRefresh(); });
    expect(await screen.findByText('Marcus Reed')).toBeTruthy();
  });
});
