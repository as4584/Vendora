/**
 * eBay listing sheet, comps card, sync-center outbox errors, and API contracts.
 */
import React from 'react';
import { Alert, Linking } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as api from '../services/api';
import {
  EbayListingCard,
  defaultEbayCondition,
  defaultEbayTitle,
  normalizePrice,
} from '../components/EbayListingCard';
import { EbayCompsCard, compsHeadline } from '../components/EbayCompsCard';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(async () => null), setItem: jest.fn(), removeItem: jest.fn() },
}));

jest.mock('../services/api', () => ({
  getEbayListing: jest.fn(),
  createEbayListing: jest.fn(),
  updateEbayListing: jest.fn(),
  endEbayListing: jest.fn(),
  getItemEbayComps: jest.fn(),
  searchEbayComps: jest.fn(),
  getEbayTraffic: jest.fn(async () => ({ summary: null, price_hint: null, watchers: null })),
}));

const m = api as jest.Mocked<typeof api>;

const ITEM = {
  id: 'item-1',
  name: 'Jordan 1 Chicago',
  size: '10',
  condition: 'used',
  expected_sell_price: '250',
  custom_attributes: { brand: 'Nike' },
} as unknown as api.InventoryItem;

const NOT_LISTED: api.EbayListing = {
  item_id: 'item-1', listed: false, status: null, offer_id: null, listing_id: null,
  url: null, price: null, quantity: null, sku: null,
};
const LIVE: api.EbayListing = {
  ...NOT_LISTED, listed: true, status: 'active', offer_id: 'O1', listing_id: 'L1',
  url: 'https://sandbox.ebay.com/itm/L1', price: '250.00', quantity: 1, sku: 'item-1',
};

beforeEach(() => jest.clearAllMocks());

describe('helpers', () => {
  it('builds title, condition and price', () => {
    expect(defaultEbayTitle(ITEM)).toBe('Nike Jordan 1 Chicago Size 10');
    expect(defaultEbayTitle({ ...ITEM, name: 'Nike Dunk', size: null } as any)).toBe('Nike Dunk');
    expect(defaultEbayCondition('used')).toBe('USED_EXCELLENT');
    expect(defaultEbayCondition('new no box')).toBe('NEW_OTHER');
    expect(defaultEbayCondition('new')).toBe('NEW');
    expect(defaultEbayCondition(null)).toBe('NEW');
    expect(normalizePrice('$1,250.5')).toBe('1250.50');
    expect(normalizePrice('0')).toBeNull();
    expect(normalizePrice('abc')).toBeNull();
  });

  it('labels asks honestly', () => {
    expect(compsHeadline({ kind: 'active_asks' } as api.EbayComps)).toMatch(/not sold/);
    expect(compsHeadline({ kind: 'sold' } as api.EbayComps)).toMatch(/sold prices/);
  });
});

describe('EbayListingCard', () => {
  it('lists an item with prefilled price, title and preview', async () => {
    m.getEbayListing.mockResolvedValue(NOT_LISTED);
    m.createEbayListing.mockResolvedValue(LIVE);
    const onChanged = jest.fn();
    const screen = render(<EbayListingCard item={ITEM} available={2} onChanged={onChanged} />);
    fireEvent.press(await screen.findByTestId('ebay-list-button'));
    expect(screen.getByTestId('ebay-price-input').props.value).toBe('250.00');
    expect(screen.getByTestId('ebay-title-input').props.value).toBe('Nike Jordan 1 Chicago Size 10');
    expect(screen.getByTestId('ebay-preview')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Condition New, no box'));
    fireEvent.changeText(screen.getByTestId('ebay-qty-input'), '2');
    await act(async () => { fireEvent.press(screen.getByTestId('ebay-submit')); });
    expect(m.createEbayListing).toHaveBeenCalledWith({
      item_id: 'item-1', price: '250.00', quantity: 2, title: 'Nike Jordan 1 Chicago Size 10', condition: 'NEW_OTHER',
    });
    expect(await screen.findByTestId('ebay-listing-live')).toBeTruthy();
    expect(screen.getByText('Live on eBay')).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });

  it('validates the form and shows backend errors', async () => {
    m.getEbayListing.mockResolvedValue(NOT_LISTED);
    m.createEbayListing.mockRejectedValue({ detail: { message: 'Your eBay account has no return policy.' } });
    const screen = render(<EbayListingCard item={ITEM} available={1} />);
    fireEvent.press(await screen.findByTestId('ebay-list-button'));
    fireEvent.changeText(screen.getByTestId('ebay-price-input'), '0');
    fireEvent.press(screen.getByTestId('ebay-submit'));
    expect(screen.getByTestId('ebay-form-error').props.children).toMatch(/price/);
    fireEvent.changeText(screen.getByTestId('ebay-price-input'), '200');
    fireEvent.changeText(screen.getByTestId('ebay-title-input'), ' ');
    fireEvent.press(screen.getByTestId('ebay-submit'));
    expect(screen.getByTestId('ebay-form-error').props.children).toMatch(/title/);
    fireEvent.changeText(screen.getByTestId('ebay-title-input'), 'Shoe');
    fireEvent.changeText(screen.getByTestId('ebay-qty-input'), '5');
    fireEvent.press(screen.getByTestId('ebay-submit'));
    expect(screen.getByTestId('ebay-form-error').props.children).toMatch(/Quantity/);
    fireEvent.changeText(screen.getByTestId('ebay-qty-input'), '1');
    await act(async () => { fireEvent.press(screen.getByTestId('ebay-submit')); });
    expect(screen.getByTestId('ebay-form-error').props.children).toMatch(/return policy/);
    fireEvent.press(screen.getByText('Cancel'));
  });

  it('updates price, opens the listing, and ends it', async () => {
    m.getEbayListing.mockResolvedValue(LIVE);
    m.updateEbayListing.mockResolvedValue({ ...LIVE, price: '199.00' });
    m.endEbayListing.mockResolvedValue({ ...LIVE, listed: false, status: 'ended', url: null });
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as any);
    const alert = jest.spyOn(Alert, 'alert');
    const screen = render(<EbayListingCard item={ITEM} available={1} />);
    fireEvent.press(await screen.findByText('View on eBay'));
    expect(open).toHaveBeenCalledWith('https://sandbox.ebay.com/itm/L1');
    fireEvent.press(screen.getByText('Update price'));
    fireEvent.changeText(screen.getByTestId('ebay-price-input'), 'x');
    fireEvent.press(screen.getByTestId('ebay-submit'));
    expect(screen.getByTestId('ebay-form-error')).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('ebay-price-input'), '199');
    await act(async () => { fireEvent.press(screen.getByTestId('ebay-submit')); });
    expect(m.updateEbayListing).toHaveBeenCalledWith('item-1', { price: '199.00' });
    expect(await screen.findByText('$199.00')).toBeTruthy();
    fireEvent.press(screen.getByText('End listing'));
    const buttons = alert.mock.calls.at(-1)![2] as any[];
    await act(async () => { await buttons[1].onPress(); });
    expect(m.endEbayListing).toHaveBeenCalledWith('item-1');
    expect(await screen.findByText('Ended')).toBeTruthy();
  });

  it('reports a failed price update and a failed end', async () => {
    m.getEbayListing.mockResolvedValue(LIVE);
    m.updateEbayListing.mockRejectedValue(new Error('nope'));
    m.endEbayListing.mockRejectedValue(new Error('boom'));
    const alert = jest.spyOn(Alert, 'alert');
    const screen = render(<EbayListingCard item={ITEM} available={1} />);
    fireEvent.press(await screen.findByText('Update price'));
    await act(async () => { fireEvent.press(screen.getByTestId('ebay-submit')); });
    expect(screen.getByTestId('ebay-form-error').props.children).toBe('nope');
    fireEvent.press(screen.getByText('Cancel'));
    fireEvent.press(screen.getByText('End listing'));
    const buttons = alert.mock.calls.at(-1)![2] as any[];
    await act(async () => { await buttons[1].onPress(); });
    expect(alert).toHaveBeenLastCalledWith('Could not end listing', 'boom');
  });

  it('handles errors, out of stock and failed listings', async () => {
    m.getEbayListing.mockRejectedValueOnce(new Error('offline'));
    const a = render(<EbayListingCard item={ITEM} available={0} />);
    expect(await a.findByText('Out of stock.')).toBeTruthy();
    m.getEbayListing.mockResolvedValueOnce({ ...NOT_LISTED, status: 'error', offer_id: 'O1' });
    const b = render(<EbayListingCard item={{ ...ITEM, expected_sell_price: null } as any} available={1} />);
    expect(await b.findByText(/did not publish/)).toBeTruthy();
    fireEvent.press(b.getByTestId('ebay-list-button'));
    expect(b.getByTestId('ebay-price-input').props.value).toBe('');
  });
});

describe('EbayCompsCard', () => {
  const COMPS: api.EbayComps = {
    query: 'q', kind: 'active_asks', label: 'eBay active asks (not sold prices)', count: 3,
    summary: { low: '200.00', median: '250.00', high: '300.00' }, items: [],
  };

  it('loads item comps and labels them as asks', async () => {
    m.getItemEbayComps.mockResolvedValue(COMPS);
    const screen = render(<EbayCompsCard itemId="item-1" />);
    await act(async () => { fireEvent.press(screen.getByTestId('ebay-comps-button')); });
    expect(screen.getByText('Current eBay asking prices (not sold prices)')).toBeTruthy();
    expect(screen.getByText('Asks')).toBeTruthy();
    expect(screen.getByText('$250')).toBeTruthy();
    expect(screen.getByText('3 listings')).toBeTruthy();
  });

  it('searches by query, uses the median, and shows sold data', async () => {
    m.searchEbayComps.mockResolvedValue({ ...COMPS, kind: 'sold' });
    const use = jest.fn();
    const screen = render(<EbayCompsCard query=" jordan " onUsePrice={use} />);
    await act(async () => { fireEvent.press(screen.getByTestId('ebay-comps-button')); });
    expect(m.searchEbayComps).toHaveBeenCalledWith('jordan');
    expect(screen.getByText('Sold')).toBeTruthy();
    expect(screen.getByText('3 sales')).toBeTruthy();
    fireEvent.press(screen.getByText('Use $250.00'));
    expect(use).toHaveBeenCalledWith('250.00');
  });

  it('handles empty results, missing query and errors', async () => {
    const empty = render(<EbayCompsCard query="" />);
    await act(async () => { fireEvent.press(empty.getByTestId('ebay-comps-button')); });
    expect(empty.getByText('Enter an item name first.')).toBeTruthy();
    m.getItemEbayComps.mockResolvedValueOnce({ ...COMPS, summary: null, count: 0 });
    const none = render(<EbayCompsCard itemId="i" />);
    await act(async () => { fireEvent.press(none.getByTestId('ebay-comps-button')); });
    expect(none.getByText('No matching eBay listings found.')).toBeTruthy();
    m.getItemEbayComps.mockRejectedValueOnce({ detail: { message: 'eBay app keys are not configured.' } });
    await act(async () => { fireEvent.press(none.getByTestId('ebay-comps-button')); });
    await waitFor(() => expect(none.getByText('eBay app keys are not configured.')).toBeTruthy());
  });
});
