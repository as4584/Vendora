import React from 'react';
import { Alert, Share } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import ShowSummaryScreen from '../app/(tabs)/settings/show-summary';

jest.mock('../services/api', () => ({
  getShowSummary: jest.fn(),
  startShow: jest.fn(),
  endShow: jest.fn(),
}));

const SUMMARY = {
  since: '2026-11-02T13:00:00Z', until: '2026-11-02T22:00:00Z', show_started_at: '2026-11-02T13:00:00Z',
  orders: 3, units_sold: 5, units_refunded: 1,
  subtotal: '255.00', discounts: '20.00', net_sales: '235.00', tax_collected: '10.00', fees: '1.50',
  refunds: '25.00', refunded_tax: '0.00', refund_count: 1, cost_of_goods: '105.00', sales_missing_cost: 1,
  profit: '103.50', collected: '220.00',
  payments: [
    { method: 'cash', collected: '175.00', refunded: '25.00', net: '150.00', count: 2 },
    { method: 'card', collected: '60.00', refunded: '0.00', net: '60.00', count: 1 },
  ],
  top_items: [{ item_id: 'i1', name: 'Dunk Low', units: 2, revenue: '181.82' }],
};
const EMPTY = {
  ...SUMMARY, show_started_at: null, orders: 0, units_sold: 0, units_refunded: 0, subtotal: '0.00', discounts: '0.00',
  net_sales: '0.00', tax_collected: '0.00', fees: '0.00', refunds: '0.00', refund_count: 0, cost_of_goods: '0.00',
  sales_missing_cost: 0, profit: '-5.00', collected: '0.00', payments: [], top_items: [],
};

describe('ShowSummaryScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as any);
    (apiMock.getShowSummary as jest.Mock).mockResolvedValue(SUMMARY);
  });
  afterEach(() => jest.restoreAllMocks());

  it('shows the close-out numbers, cash box, top items and shares as text', async () => {
    const screen = render(<ShowSummaryScreen />);
    await screen.findByText('Show in progress');
    expect(screen.getAllByText('$103.50').length).toBeGreaterThan(0);
    expect(screen.getByText('3 orders · 5 units sold')).toBeTruthy();
    expect(screen.getByText('-$20.00')).toBeTruthy();
    expect(screen.getByText('Refunds · 1')).toBeTruthy();
    expect(screen.getByText('Cash (after $25.00 refunded)')).toBeTruthy();
    expect(screen.getByText('$220.00')).toBeTruthy();
    expect(screen.getByText('Dunk Low')).toBeTruthy();
    expect(screen.getByText(/1 sale had no buy price/)).toBeTruthy();
    expect(apiMock.getShowSummary).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByText('Share summary'));
    await waitFor(() => expect(Share.share).toHaveBeenCalled());
    const text = (Share.share as jest.Mock).mock.calls[0][0].message as string;
    expect(text).toMatch(/^Show summary since/);
    expect(text).toContain('Cash  $150.00');
    expect(text).toContain('Sales tax collected  $10.00');
    expect(text).toContain('Refunds (1)  -$25.00');
    expect(text).toContain('Dunk Low  2 sold · $181.82');
  });

  it('falls back to local midnight with no show, and starts one', async () => {
    (apiMock.getShowSummary as jest.Mock).mockResolvedValue(EMPTY);
    (apiMock.startShow as jest.Mock).mockResolvedValue(SUMMARY);
    const screen = render(<ShowSummaryScreen />);
    await screen.findByText('No show running');
    await waitFor(() => expect(apiMock.getShowSummary).toHaveBeenCalledTimes(2));
    expect((apiMock.getShowSummary as jest.Mock).mock.calls[1][0].since).toBeDefined();
    expect(screen.getByText('No payments in this window.')).toBeTruthy();
    expect(screen.getByText('Nothing sold yet.')).toBeTruthy();
    expect(screen.getAllByText('-$5.00').length).toBeGreaterThan(0);
    fireEvent.press(screen.getByText('Start'));
    await screen.findByText('Show in progress');
  });

  it('switches windows', async () => {
    const screen = render(<ShowSummaryScreen />);
    await screen.findByText('Show in progress');
    fireEvent.press(screen.getByText('Today'));
    await waitFor(() => expect(apiMock.getShowSummary).toHaveBeenCalledTimes(2));
    fireEvent.press(screen.getByText('7 days'));
    await waitFor(() => expect(apiMock.getShowSummary).toHaveBeenCalledTimes(3));
    const since7 = new Date((apiMock.getShowSummary as jest.Mock).mock.calls[2][0].since);
    const sinceToday = new Date((apiMock.getShowSummary as jest.Mock).mock.calls[1][0].since);
    expect(sinceToday.getTime() - since7.getTime()).toBeGreaterThanOrEqual(6 * 23 * 3600 * 1000);
    fireEvent.press(screen.getByText('This show'));
    await waitFor(() => expect(apiMock.getShowSummary).toHaveBeenLastCalledWith({ since: SUMMARY.show_started_at }));
    fireEvent.press(screen.getByText('Share summary'));
    await waitFor(() => expect(Share.share).toHaveBeenCalled());
  });

  it('ends the show after confirming', async () => {
    (apiMock.endShow as jest.Mock).mockResolvedValue(undefined);
    const screen = render(<ShowSummaryScreen />);
    await screen.findByText('Show in progress');
    (apiMock.getShowSummary as jest.Mock).mockResolvedValue(EMPTY);
    fireEvent.press(screen.getByText('End'));
    const buttons = (Alert.alert as jest.Mock).mock.calls[0][2];
    await act(async () => buttons[1].onPress());
    await screen.findByText('No show running');
    expect(apiMock.endShow).toHaveBeenCalled();
  });

  it('reports errors', async () => {
    (apiMock.getShowSummary as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    (apiMock.startShow as jest.Mock).mockRejectedValueOnce(new Error('nope'));
    (apiMock.endShow as jest.Mock).mockRejectedValueOnce(new Error('later'));
    const screen = render(<ShowSummaryScreen />);
    await screen.findByText('offline');
    fireEvent.press(screen.getByText('Start'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith("Couldn't start the show", 'nope'));

    (apiMock.getShowSummary as jest.Mock).mockRejectedValueOnce(new Error('still offline'));
    fireEvent.press(screen.getByText('Today'));
    await screen.findByText('still offline');

    (apiMock.getShowSummary as jest.Mock).mockResolvedValue(SUMMARY);
    fireEvent.press(screen.getByText('This show'));
    await screen.findByText('Show in progress');
    fireEvent.press(screen.getByText('End'));
    const buttons = (Alert.alert as jest.Mock).mock.calls.at(-1)[2];
    await act(async () => buttons[1].onPress());
    expect(Alert.alert).toHaveBeenLastCalledWith("Couldn't end the show", 'later');
  });
});
