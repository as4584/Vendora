/**
 * eBay insights: traffic line + price hint, send offer to watchers, payouts.
 */
import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as api from '../services/api';
import { EbayInsights } from '../components/EbayInsights';
import { EbayPayouts, feeParts } from '../components/EbayPayouts';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(async () => null), setItem: jest.fn(), removeItem: jest.fn() },
}));

jest.mock('../services/api', () => ({
  getEbayTraffic: jest.fn(),
  sendEbayOffer: jest.fn(),
  listEbayPayouts: jest.fn(),
  listEbayFees: jest.fn(),
  syncEbayFinances: jest.fn(),
}));

const m = api as jest.Mocked<typeof api>;

const TRAFFIC: api.EbayTraffic = {
  listing_id: 'L1', available: true, views: 48, impressions: 900, click_through_rate: '0.05',
  conversion_rate: '0', sales: 0, watchers: 3, day: '2026-11-03',
  price_hint: 'Lots of views but no sales yet. The price may be a little high.',
  summary: '48 views · 3 watchers · 0 sales',
};

beforeEach(() => jest.clearAllMocks());

describe('EbayInsights', () => {
  it('shows traffic and the gentle price hint, and refreshes', async () => {
    m.getEbayTraffic.mockResolvedValue(TRAFFIC);
    const s = render(<EbayInsights itemId="i1" listPrice="250.00" />);
    expect(await s.findByText('48 views · 3 watchers · 0 sales')).toBeTruthy();
    expect(s.getByTestId('ebay-price-hint')).toBeTruthy();
    await act(async () => { fireEvent.press(s.getByText('Refresh stats')); });
    expect(m.getEbayTraffic).toHaveBeenLastCalledWith('i1', true);
  });

  it('sends a percent-off offer with length and message', async () => {
    m.getEbayTraffic.mockResolvedValue(TRAFFIC);
    m.sendEbayOffer.mockResolvedValue({ listing_id: 'L1', offers_sent: 3, offer_ids: [] });
    const s = render(<EbayInsights itemId="i1" listPrice="250.00" />);
    await s.findByText('48 views · 3 watchers · 0 sales');
    fireEvent.press(s.getByTestId('ebay-offer-button'));
    expect(s.getByText(/3 watching/)).toBeTruthy();
    fireEvent.press(s.getByText('15% off'));
    fireEvent.changeText(s.getByTestId('ebay-offer-days'), '3');
    fireEvent.changeText(s.getByTestId('ebay-offer-message'), ' Thanks for watching ');
    await act(async () => { fireEvent.press(s.getByTestId('ebay-offer-submit')); });
    expect(m.sendEbayOffer).toHaveBeenCalledWith('i1', { duration_days: 3, message: 'Thanks for watching', discount_percent: 15 });
    expect(s.getByText('Offer sent to 3 buyers.')).toBeTruthy();
  });

  it('validates price offers and shows errors', async () => {
    m.getEbayTraffic.mockResolvedValue({ ...TRAFFIC, watchers: null, summary: null, price_hint: null });
    m.sendEbayOffer
      .mockRejectedValueOnce({ detail: { message: 'No interested buyers yet.' } })
      .mockResolvedValueOnce({ listing_id: 'L1', offers_sent: 1, offer_ids: ['x'] });
    const s = render(<EbayInsights itemId="i1" listPrice="250.00" />);
    await waitFor(() => expect(m.getEbayTraffic).toHaveBeenCalled());
    fireEvent.press(s.getByTestId('ebay-offer-button'));
    fireEvent.changeText(s.getByTestId('ebay-offer-days'), '0');
    fireEvent.press(s.getByTestId('ebay-offer-submit'));
    expect(s.getByTestId('ebay-offer-error').props.children).toMatch(/1 to 30/);
    fireEvent.changeText(s.getByTestId('ebay-offer-days'), '2');
    fireEvent.press(s.getByText('Set price'));
    fireEvent.changeText(s.getByTestId('ebay-offer-price'), 'x');
    fireEvent.press(s.getByTestId('ebay-offer-submit'));
    expect(s.getByTestId('ebay-offer-error').props.children).toMatch(/price above/);
    fireEvent.changeText(s.getByTestId('ebay-offer-price'), '260');
    fireEvent.press(s.getByTestId('ebay-offer-submit'));
    expect(s.getByTestId('ebay-offer-error').props.children).toMatch(/below the listing/);
    fireEvent.changeText(s.getByTestId('ebay-offer-price'), '220');
    await act(async () => { fireEvent.press(s.getByTestId('ebay-offer-submit')); });
    expect(s.getByTestId('ebay-offer-error').props.children).toBe('No interested buyers yet.');
    await act(async () => { fireEvent.press(s.getByTestId('ebay-offer-submit')); });
    expect(m.sendEbayOffer).toHaveBeenLastCalledWith('i1', { duration_days: 2, message: undefined, price: '220.00' });
    expect(s.getByText('Offer sent to 1 buyer.')).toBeTruthy();
  });

  it('survives a traffic error and cancel', async () => {
    m.getEbayTraffic.mockRejectedValue(new Error('x'));
    const s = render(<EbayInsights itemId="i1" listPrice={null} />);
    await waitFor(() => expect(m.getEbayTraffic).toHaveBeenCalled());
    fireEvent.press(s.getByTestId('ebay-offer-button'));
    fireEvent.press(s.getByText('Set price'));
    fireEvent.changeText(s.getByTestId('ebay-offer-price'), '10');
    m.sendEbayOffer.mockRejectedValueOnce(new Error('boom'));
    await act(async () => { fireEvent.press(s.getByTestId('ebay-offer-submit')); });
    expect(s.getByTestId('ebay-offer-error').props.children).toBe('boom');
    fireEvent.press(s.getByText('Cancel'));
  });
});

describe('EbayPayouts', () => {
  const PAYOUT: api.EbayPayout = {
    payout_id: 'P1', amount: '202.15', currency: 'USD', status: 'SUCCEEDED', payout_date: null,
    transaction_count: 3, ebay_net: '202.15', resqlo_net: '202.15', difference: '0.00',
    orders_matched: 1, orders_missing: 0, reconciled: true,
  };
  const FEE: api.EbayOrderFees = {
    order_id: 'O1', transaction_id: 't', gross: '250.00', final_value_fee: '32.90', ad_fee: '5.00',
    shipping_label: '9.10', other_fees: '0.85', total_fees: '47.85', net: '202.15', payout_id: 'P1',
  };

  it('renders nothing when not connected', () => {
    const s = render(<EbayPayouts connected={false} />);
    expect(s.toJSON()).toBeNull();
  });

  it('shows reconciled and mismatched payouts with fee breakdown, and syncs', async () => {
    m.listEbayPayouts.mockResolvedValue([
      PAYOUT,
      { ...PAYOUT, payout_id: 'P2', reconciled: false, orders_missing: 2 },
      { ...PAYOUT, payout_id: 'P3', reconciled: false, orders_matched: 2, difference: '1.50' },
      { ...PAYOUT, payout_id: 'P4', reconciled: true, orders_matched: 2 },
    ]);
    m.listEbayFees.mockResolvedValue([FEE]);
    m.syncEbayFinances.mockResolvedValueOnce({ orders_with_fees: 1, transactions_updated: 1, payouts: 1 })
      .mockRejectedValueOnce(new Error('scope'));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const s = render(<EbayPayouts connected />);
    expect(await s.findByText('Matches 1 order')).toBeTruthy();
    expect(s.getByText('2 orders not imported yet')).toBeTruthy();
    expect(s.getByText('Off by $1.50')).toBeTruthy();
    expect(s.getByText('Matches 2 orders')).toBeTruthy();
    expect(s.getByText('Order O1: $250.00 sold, $202.15 net')).toBeTruthy();
    await act(async () => { fireEvent.press(s.getByTestId('ebay-fees-sync')); });
    expect(m.syncEbayFinances).toHaveBeenCalled();
    await act(async () => { fireEvent.press(s.getByTestId('ebay-fees-sync')); });
    expect(alert).toHaveBeenCalledWith('eBay fees unavailable', 'scope');
  });

  it('handles empty and failing loads', async () => {
    m.listEbayPayouts.mockRejectedValue(new Error('x'));
    m.listEbayFees.mockRejectedValue(new Error('x'));
    const s = render(<EbayPayouts connected />);
    expect(await s.findByText(/Sync eBay fees to see payouts/)).toBeTruthy();
  });

  it('formats fee parts', () => {
    expect(feeParts(FEE)).toBe('Final value $32.90 · Ads $5.00 · Label $9.10 · Other $0.85');
    expect(feeParts({ ...FEE, final_value_fee: '0', ad_fee: '0', shipping_label: '0', other_fees: '0' })).toBe('No fees');
    expect(feeParts({ ...FEE, gross: null } as any)).toMatch(/Final value/);
  });
});
