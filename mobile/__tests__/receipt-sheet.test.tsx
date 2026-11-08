import React from 'react';
import { Alert, Modal } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { ReceiptSheet } from '../components/ReceiptSheet';
import { downloadAndShareRemote } from '../utils/fileActions';
import { useReducedMotion } from '../components/useReducedMotion';

jest.mock('../components/useReducedMotion', () => ({ useReducedMotion: jest.fn(() => true) }));

jest.mock('../services/api', () => ({
  getToken: jest.fn().mockResolvedValue('tok'),
  orderReceiptPdfUrl: (id: string) => `https://api.test/transactions/order/${id}/receipt.pdf`,
}));
jest.mock('../utils/fileActions', () => ({ downloadAndShareRemote: jest.fn() }));

const RECEIPT = {
  date: new Date(2026, 10, 3, 14, 41),
  lines: [{ name: 'Dunk Low', qty: 1, unitCents: 15000 }],
  subtotal: 15000,
  discount: 0,
  tax: 0,
  total: 15000,
  payments: [{ method: 'cash', cents: 15000 }],
};

describe('ReceiptSheet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useReducedMotion as jest.Mock).mockReturnValue(true);
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('downloads the PDF receipt and hands it to the share sheet', async () => {
    (downloadAndShareRemote as jest.Mock).mockResolvedValue(undefined);
    const screen = render(
      <ReceiptSheet receipt={{ ...RECEIPT, orderId: 'abcdef12-3456' }} onNewSale={jest.fn()} onDone={jest.fn()} />,
    );
    expect(screen.getByText('Share receipt')).toBeTruthy();
    fireEvent.press(screen.getByText('Share PDF'));
    await waitFor(() => expect(downloadAndShareRemote).toHaveBeenCalled());
    const [url, filename, token, mime] = (downloadAndShareRemote as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.test/transactions/order/abcdef12-3456/receipt.pdf');
    expect(filename).toBe('receipt-abcdef12.pdf');
    expect(token).toBe('tok');
    expect(mime).toBe('application/pdf');
  });

  it('reports a failed download', async () => {
    (downloadAndShareRemote as jest.Mock).mockRejectedValue(new Error('Could not get the PDF receipt (500).'));
    const screen = render(
      <ReceiptSheet receipt={{ ...RECEIPT, orderId: 'o1' }} onNewSale={jest.fn()} onDone={jest.fn()} />,
    );
    fireEvent.press(screen.getByText('Share PDF'));
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith('PDF receipt', 'Could not get the PDF receipt (500).'),
    );
  });

  it('hides Share PDF for offline (unsynced) sales', () => {
    const screen = render(
      <ReceiptSheet receipt={{ ...RECEIPT, pending: true }} onNewSale={jest.fn()} onDone={jest.fn()} />,
    );
    expect(screen.queryByText('Share PDF')).toBeNull();
    expect(screen.getByText('Share receipt')).toBeTruthy();
    expect(screen.queryByText('SOLD')).toBeNull();
  });

  it('shows SOLD for confirmed sales without motion when requested', () => {
    const screen = render(<ReceiptSheet receipt={RECEIPT} onNewSale={jest.fn()} onDone={jest.fn()} />);
    expect(screen.getByText('SOLD')).toBeTruthy();
    expect(screen.UNSAFE_getByType(Modal).props.animationType).toBe('none');
  });

  it('allows the receipt entrance when motion is enabled', () => {
    (useReducedMotion as jest.Mock).mockReturnValue(false);
    const screen = render(<ReceiptSheet receipt={RECEIPT} onNewSale={jest.fn()} onDone={jest.fn()} />);
    expect(screen.UNSAFE_getByType(Modal).props.animationType).toBe('slide');
    screen.unmount();
  });
});
