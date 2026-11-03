/**
 * Recording payments against an invoice: balance summary, history, the
 * record-payment form (amount, method, note), client-side overpay checks,
 * and the preview's balance due.
 */
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import {
  InvoicePayments,
  invoiceStatusLabel,
  invoiceStatusTone,
  methodLabel,
  parseAmountCents,
} from '../components/InvoicePayments';
import { invoiceBalance, invoiceLabel, invoicePaid } from '../utils/invoices';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(async () => null), setItem: jest.fn(async () => undefined), removeItem: jest.fn(async () => undefined) },
}));

jest.mock('../services/api', () => ({ recordInvoicePayment: jest.fn(), getInvoice: jest.fn() }));

const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack }),
  useLocalSearchParams: () => ({ id: 'inv-1' }),
}));
jest.mock('../context/auth', () => ({ useAuth: () => ({ user: {} }) }));

const record = apiMock.recordInvoicePayment as jest.Mock;

const SENT: any = {
  id: 'inv-1',
  invoice_number: 'INV0003',
  customer_name: 'Sam',
  customer_email: null,
  status: 'sent',
  subtotal: '100.00', tax: '0.00', shipping: '0.00', discount: '0.00',
  total: '100.00',
  amount_paid: '0.00',
  balance_due: '100.00',
  payments: [],
  items: [{ id: 'l1', description: 'Dunk', quantity: 1, unit_price: '100.00', line_total: '100.00', size_label: null }],
  notes: null,
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-01T00:00:00Z',
};

const PARTIAL = {
  ...SENT,
  status: 'partially_paid',
  amount_paid: '30.00',
  balance_due: '70.00',
  payments: [{ id: 'p1', invoice_id: 'inv-1', amount: '30.00', method: 'zelle', note: 'deposit', created_at: '2026-05-01T00:00:00Z' }],
};

describe('invoice helpers', () => {
  it('labels and tones statuses for people', () => {
    expect(invoiceStatusLabel({ ...SENT, _pending: true })).toBe('PENDING SYNC');
    expect(invoiceStatusLabel(PARTIAL)).toBe('PART PAID');
    expect(invoiceStatusLabel(SENT)).toBe('SENT');
    expect(invoiceStatusTone({ ...SENT, _pending: true })).toBe('neutral');
    expect(invoiceStatusTone({ ...SENT, status: 'paid' })).toBe('success');
    expect(invoiceStatusTone(PARTIAL)).toBe('info');
    expect(invoiceStatusTone({ ...SENT, status: 'draft' })).toBe('warning');
  });

  it('never shows a guessed number for offline invoices', () => {
    expect(invoiceLabel({ invoice_number: '', _pending: true })).toBe('Pending sync');
    expect(invoiceLabel({ invoice_number: 'INV0001' })).toBe('INV0001');
    expect(invoiceLabel({ invoice_number: undefined })).toBe('Invoice');
  });

  it('falls back for responses from older servers', () => {
    expect(invoiceBalance({ status: 'paid', total: '50.00' } as any)).toBe(0);
    expect(invoiceBalance({ status: 'sent', total: '50.00' } as any)).toBe(50);
    expect(invoicePaid({ status: 'paid', total: '50.00' } as any)).toBe(50);
    expect(invoicePaid({ status: 'sent', total: '50.00' } as any)).toBe(0);
    expect(invoicePaid(PARTIAL)).toBe(30);
  });

  it('parses amounts and method names', () => {
    expect(parseAmountCents('$1,234.5')).toBe(123450);
    expect(parseAmountCents('0')).toBeNull();
    expect(parseAmountCents('abc')).toBeNull();
    expect(parseAmountCents('1.234')).toBeNull();
    expect(methodLabel('cashapp')).toBe('Cash App');
    expect(methodLabel('barter')).toBe('barter');
  });
});

describe('InvoicePayments', () => {
  beforeEach(() => record.mockReset());

  it('records a partial payment with method and note', async () => {
    record.mockResolvedValue(PARTIAL);
    const onRecorded = jest.fn();
    const screen = render(<InvoicePayments invoice={SENT} onRecorded={onRecorded} />);
    expect(screen.getByText('Balance due')).toBeTruthy();
    fireEvent.press(screen.getByText('Record payment'));
    expect(screen.getByLabelText('Payment amount').props.value).toBe('100.00');
    fireEvent.changeText(screen.getByLabelText('Payment amount'), '30');
    fireEvent.press(screen.getByLabelText('Zelle'));
    fireEvent.changeText(screen.getByLabelText('Payment note'), '  deposit ');
    await act(async () => {
      fireEvent.press(screen.getByText('Save payment'));
    });
    expect(record).toHaveBeenCalledWith('inv-1', { amount: '30.00', method: 'zelle', note: 'deposit' });
    expect(onRecorded).toHaveBeenCalledWith(PARTIAL);
    expect(screen.queryByLabelText('Payment amount')).toBeNull();
  });

  it('pays the balance in full by default', async () => {
    record.mockResolvedValue({ ...PARTIAL, status: 'paid', amount_paid: '100.00', balance_due: '0.00' });
    const screen = render(<InvoicePayments invoice={PARTIAL} onRecorded={jest.fn()} />);
    expect(screen.getByText(/Zelle/)).toBeTruthy();
    expect(screen.getByText('deposit')).toBeTruthy();
    fireEvent.press(screen.getByText('Record payment'));
    await act(async () => {
      fireEvent.press(screen.getByText('Save payment'));
    });
    expect(record).toHaveBeenCalledWith('inv-1', { amount: '70.00', method: 'cash', note: undefined });
  });

  it('rejects overpayment and empty amounts before calling the server', () => {
    const screen = render(<InvoicePayments invoice={PARTIAL} onRecorded={jest.fn()} />);
    fireEvent.press(screen.getByText('Record payment'));
    fireEvent.changeText(screen.getByLabelText('Payment amount'), '70.01');
    fireEvent.press(screen.getByText('Save payment'));
    expect(screen.getByText(/more than the \$70.00 balance due/)).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText('Payment amount'), '');
    fireEvent.press(screen.getByText('Save payment'));
    expect(screen.getByText(/more than \$0.00/)).toBeTruthy();
    expect(record).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText('Cancel'));
    expect(screen.getByText('Record payment')).toBeTruthy();
  });

  it('shows server errors', async () => {
    record.mockRejectedValueOnce(new Error('Server says no')).mockRejectedValueOnce({});
    const screen = render(<InvoicePayments invoice={SENT} onRecorded={jest.fn()} />);
    fireEvent.press(screen.getByText('Record payment'));
    await act(async () => {
      fireEvent.press(screen.getByText('Save payment'));
    });
    expect(screen.getByText('Server says no')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('Save payment'));
    });
    expect(screen.getByText('Could not record the payment.')).toBeTruthy();
  });

  it('hides the form on paid, cancelled and pending invoices', () => {
    const paid = render(<InvoicePayments invoice={{ ...SENT, status: 'paid', balance_due: '0.00' }} onRecorded={jest.fn()} />);
    expect(paid.queryByText('Record payment')).toBeNull();
    const cancelled = render(<InvoicePayments invoice={{ ...SENT, status: 'cancelled' }} onRecorded={jest.fn()} />);
    expect(cancelled.queryByText('Record payment')).toBeNull();
    const pending = render(<InvoicePayments invoice={{ ...SENT, _pending: true }} onRecorded={jest.fn()} />);
    expect(pending.queryByText('Record payment')).toBeNull();
    expect(pending.getByText(/once this invoice syncs/)).toBeTruthy();
  });
});

describe('invoice preview balance', () => {
  const InvoicePreviewScreen = require('../app/(tabs)/inventory/invoice-preview').default;

  it('shows paid, balance due and payment history', async () => {
    (apiMock.getInvoice as jest.Mock).mockResolvedValue(PARTIAL);
    const screen = render(<InvoicePreviewScreen />);
    await screen.findByText('Sam');
    expect(screen.getByTestId('preview-balance-due')).toHaveTextContent('$70.00');
    expect(screen.getByText('PAYMENTS')).toBeTruthy();
    expect(screen.getByText(/Zelle · deposit/)).toBeTruthy();
    expect(screen.getByText('PART PAID')).toBeTruthy();
    expect(screen.getByText('INV0003')).toBeTruthy();
  });

  it('shows Pending sync for an offline invoice and a payment without a note', async () => {
    (apiMock.getInvoice as jest.Mock).mockResolvedValue({
      ...PARTIAL,
      _pending: true,
      payments: [{ ...PARTIAL.payments[0], note: null }],
    });
    const screen = render(<InvoicePreviewScreen />);
    await waitFor(() => expect(screen.getAllByText(/PENDING SYNC|Pending sync/).length).toBe(2));
  });
});
