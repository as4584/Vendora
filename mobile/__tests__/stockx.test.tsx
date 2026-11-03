import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import * as api from '../services/api';
import {
  FEE_DISCLAIMER,
  StockxItemCard,
  StockxPriceHint,
  StockxSettingsCard,
  marketLine,
} from '../components/Stockx';

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn(async () => ({ type: 'cancel' })) }));
jest.mock('expo-linking', () => ({ createURL: jest.fn(() => 'vendora://settings') }));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(), notificationAsync: jest.fn(), ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
jest.mock('../services/api', () => ({
  getStockxStatus: jest.fn(),
  getStockxConnectUrl: jest.fn(),
  disconnectStockx: jest.fn(),
  syncStockx: jest.fn(),
  getStockxItem: jest.fn(),
  getStockxMatch: jest.fn(),
  confirmStockxMatch: jest.fn(),
  getStockxMarket: jest.fn(),
  getStockxQuote: jest.fn(),
  placeStockxAsk: jest.fn(),
  updateStockxAsk: jest.fn(),
  removeStockxAsk: jest.fn(),
}));

const m = api as jest.Mocked<typeof api>;
const READY: api.StockxStatus = { configured: true, connected: true, account_id: null, expires_at: null, matched_items: 2, open_listings: 1, outbox_errors: 1 };
const LINK = { product_id: 'p1', variant_id: 'v10', size: '10' };
const MARKET: api.StockxMarket = { product_id: 'p1', variant_id: 'v10', size: '10', currency_code: 'USD', lowest_ask: '260', highest_bid: null, last_sale: '244.5', fetched_at: '', stale: true };
const LISTING: api.StockxListing = {
  id: 'l1', inventory_item_id: 'i1', product_id: 'p1', variant_id: 'v10', size: '10', listing_id: 'x', amount: '275.00', currency_code: 'USD', status: 'active', last_error: null,
};
const CANDIDATE: api.StockxCandidate = { product_id: 'p1', title: 'Jordan 1 Chicago', style_id: 'DZ5485-612', brand: 'Jordan', colorway: 'Red', score: 0.9 };

function pressAlertButton(label: string) {
  const calls = (Alert.alert as jest.Mock).mock.calls;
  const buttons = calls[calls.length - 1][2] as { text: string; onPress?: () => unknown }[];
  return buttons.find((b) => b.text === label)!.onPress!();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  m.getStockxStatus.mockResolvedValue(READY);
});

describe('marketLine', () => {
  it('labels sales, asks and bids separately and never mislabels', () => {
    expect(marketLine(null)).toBe('StockX: no market data');
    expect(marketLine({ last_sale: null, lowest_ask: '', highest_bid: 'x' })).toBe('StockX: no market data');
    expect(marketLine({ last_sale: '244.5', lowest_ask: '260', highest_bid: '230' })).toBe(
      'StockX: last sale $244.50 · lowest ask $260.00 · highest bid $230.00',
    );
    expect(marketLine({ last_sale: null, lowest_ask: '260', highest_bid: null })).toBe('StockX: lowest ask $260.00');
  });
});

describe('StockxSettingsCard', () => {
  it('shows not configured', async () => {
    m.getStockxStatus.mockResolvedValue({ ...READY, configured: false, connected: false });
    render(<StockxSettingsCard />);
    expect(await screen.findByText('StockX not configured')).toBeTruthy();
    expect(screen.queryByText('Connect StockX')).toBeNull();
  });

  it('shows an unavailable note when status fails', async () => {
    m.getStockxStatus.mockRejectedValue(new Error('down'));
    render(<StockxSettingsCard />);
    expect(await screen.findByText('StockX status is unavailable right now.')).toBeTruthy();
  });

  it('connects through the auth browser and reports failures', async () => {
    m.getStockxStatus.mockResolvedValue({ ...READY, connected: false });
    m.getStockxConnectUrl.mockResolvedValueOnce({ authorization_url: 'https://accounts.stockx.test/authorize' });
    render(<StockxSettingsCard />);
    fireEvent.press(await screen.findByText('Connect StockX'));
    await waitFor(() => expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith('https://accounts.stockx.test/authorize', 'vendora://settings'));
    m.getStockxConnectUrl.mockRejectedValueOnce(new Error('StockX not configured'));
    fireEvent.press(screen.getByText('Connect StockX'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('StockX unavailable', 'StockX not configured'));
  });

  it('syncs and disconnects when connected', async () => {
    m.syncStockx.mockResolvedValueOnce({ transactions_imported: 2, outbox_processed: 0 });
    render(<StockxSettingsCard />);
    expect(await screen.findByText('2 matched item(s), 1 open ask(s), 1 sync error(s)')).toBeTruthy();
    fireEvent.press(screen.getByText('Sync StockX'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('StockX synced', '2 new sale(s) imported.'));
    m.syncStockx.mockRejectedValueOnce(new Error('rate limited'));
    fireEvent.press(screen.getByText('Sync StockX'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('StockX sync failed', 'rate limited'));

    fireEvent.press(screen.getByText('Disconnect'));
    m.disconnectStockx.mockResolvedValueOnce({ disconnected: true, links_retained: 1 });
    await act(async () => { await pressAlertButton('Disconnect'); });
    expect(m.disconnectStockx).toHaveBeenCalled();
    fireEvent.press(screen.getByText('Disconnect'));
    m.disconnectStockx.mockRejectedValueOnce(new Error('nope'));
    await act(async () => { await pressAlertButton('Disconnect'); });
    expect(Alert.alert).toHaveBeenCalledWith('Disconnect failed', 'nope');
  });
});

describe('StockxPriceHint', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('shows the market line for a confident match', async () => {
    m.getStockxQuote.mockResolvedValue({ product: CANDIDATE, variant_id: 'v10', market: MARKET });
    render(<StockxPriceHint name="Jordan 1 Chicago" size="10" />);
    await act(async () => { jest.advanceTimersByTime(700); });
    expect(await screen.findByTestId('stockx-price-hint')).toBeTruthy();
    expect(screen.getByText('StockX: last sale $244.50 · lowest ask $260.00')).toBeTruthy();
    expect(m.getStockxQuote).toHaveBeenCalledWith('Jordan 1 Chicago', '10');
  });

  it('stays hidden when not connected, too short, unmatched or failing', async () => {
    m.getStockxStatus.mockResolvedValue({ ...READY, connected: false });
    const view = render(<StockxPriceHint name="Jordan 1" />);
    await act(async () => { jest.advanceTimersByTime(700); });
    expect(m.getStockxQuote).not.toHaveBeenCalled();
    view.rerender(<StockxPriceHint name="ab" />);
    expect(screen.queryByTestId('stockx-price-hint')).toBeNull();

    m.getStockxStatus.mockResolvedValue(READY);
    m.getStockxQuote.mockResolvedValueOnce({ product: null, variant_id: null, market: null });
    view.rerender(<StockxPriceHint name="Unknown shoe" />);
    await act(async () => { jest.advanceTimersByTime(700); });
    expect(screen.queryByTestId('stockx-price-hint')).toBeNull();

    m.getStockxQuote.mockRejectedValueOnce(new Error('429'));
    view.rerender(<StockxPriceHint name="Other shoe" />);
    await act(async () => { jest.advanceTimersByTime(700); });
    expect(screen.queryByTestId('stockx-price-hint')).toBeNull();
    view.unmount();
  });
});

describe('StockxItemCard', () => {
  it('degrades when not configured or not connected', async () => {
    m.getStockxStatus.mockResolvedValueOnce({ ...READY, configured: false });
    const view = render(<StockxItemCard itemId="i1" />);
    expect(await screen.findByText('StockX not configured')).toBeTruthy();
    view.unmount();
    m.getStockxStatus.mockResolvedValueOnce({ ...READY, connected: false });
    render(<StockxItemCard itemId="i1" />);
    expect(await screen.findByText('StockX not connected. Connect it in Settings.')).toBeTruthy();
    expect(m.getStockxItem).not.toHaveBeenCalled();
  });

  it('renders nothing while status errors', async () => {
    m.getStockxStatus.mockRejectedValueOnce(new Error('x'));
    const view = render(<StockxItemCard itemId="i1" />);
    await waitFor(() => expect(m.getStockxStatus).toHaveBeenCalled());
    expect(view.toJSON()).toBeNull();
  });

  it('matches an unmatched item through the shortlist sheet', async () => {
    m.getStockxItem.mockResolvedValueOnce({ links: [], listings: [] }).mockResolvedValue({ links: [LINK], listings: [] });
    m.getStockxMarket.mockResolvedValue([MARKET]);
    m.getStockxMatch.mockResolvedValue({ best: CANDIDATE, shortlist: [CANDIDATE, { ...CANDIDATE, product_id: 'p2', title: 'Jordan 1 Bred', style_id: null, colorway: null }] });
    m.confirmStockxMatch.mockResolvedValueOnce({ links: [LINK], listings: [] });
    render(<StockxItemCard itemId="i1" />);
    expect(await screen.findByText('Not matched to a StockX product yet.')).toBeTruthy();
    fireEvent.press(screen.getByText('Match on StockX'));
    expect(await screen.findByText('Jordan 1 Bred')).toBeTruthy();
    expect(screen.getByText('DZ5485-612 · Red  Best match')).toBeTruthy();
    fireEvent.press(screen.getAllByText('Use this')[0]);
    await waitFor(() => expect(m.confirmStockxMatch).toHaveBeenCalledWith('i1', 'p1'));
    expect(await screen.findByText('StockX: last sale $244.50 · lowest ask $260.00 (cached)')).toBeTruthy();
  });

  it('reports match sheet errors, empty results, no-size matches and save failures', async () => {
    m.getStockxItem.mockResolvedValue({ links: [], listings: [] });
    m.getStockxMatch.mockRejectedValueOnce(new Error('StockX error: 429'));
    render(<StockxItemCard itemId="i1" />);
    fireEvent.press(await screen.findByText('Match on StockX'));
    expect(await screen.findByText('StockX error: 429')).toBeTruthy();
    fireEvent.press(screen.getByText('Cancel'));

    m.getStockxMatch.mockResolvedValueOnce({ best: null, shortlist: [] });
    fireEvent.press(screen.getByText('Match on StockX'));
    expect(await screen.findByText('No StockX products found.')).toBeTruthy();
    fireEvent.press(screen.getByText('Cancel'));

    m.getStockxMatch.mockResolvedValue({ best: null, shortlist: [CANDIDATE] });
    m.confirmStockxMatch.mockRejectedValueOnce(new Error('bad'));
    fireEvent.press(screen.getByText('Match on StockX'));
    fireEvent.press(await screen.findByText('Use this'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Could not save match', 'bad'));

    m.confirmStockxMatch.mockResolvedValueOnce({ links: [], listings: [] });
    fireEvent.press(screen.getByText('Use this'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('No size match', expect.any(String)));
  });

  it('places an ask with the fee disclaimer and validates the price', async () => {
    m.getStockxItem.mockResolvedValue({ links: [LINK], listings: [] });
    m.getStockxMarket.mockResolvedValue([]);
    m.placeStockxAsk.mockRejectedValueOnce(new Error('below minimum')).mockResolvedValue(LISTING);
    render(<StockxItemCard itemId="i1" />);
    expect(await screen.findByText('StockX: no market data')).toBeTruthy();
    fireEvent.press(screen.getByText('Place ask'));
    expect(screen.getByText(FEE_DISCLAIMER)).toBeTruthy();
    fireEvent.press(screen.getAllByText('Place ask').at(-1)!);
    expect(Alert.alert).toHaveBeenCalledWith('Enter a price', expect.any(String));
    fireEvent.changeText(screen.getByLabelText('Ask price'), '275');
    fireEvent.press(screen.getAllByText('Place ask').at(-1)!);
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('StockX ask failed', 'below minimum'));
    fireEvent.press(screen.getAllByText('Place ask').at(-1)!);
    await waitFor(() => expect(m.placeStockxAsk).toHaveBeenLastCalledWith('i1', 'v10', '275.00'));
  });

  it('updates and removes an existing ask', async () => {
    m.getStockxItem.mockResolvedValue({ links: [LINK], listings: [LISTING, { ...LISTING, id: 'old', status: 'deleted' }] });
    m.getStockxMarket.mockRejectedValueOnce(new Error('x')).mockResolvedValue([MARKET]);
    m.updateStockxAsk.mockResolvedValue(LISTING);
    render(<StockxItemCard itemId="i1" />);
    expect(await screen.findByText(/Your ask \$275\.00/)).toBeTruthy();
    fireEvent.press(screen.getByText('Update'));
    fireEvent.changeText(screen.getByLabelText('Ask price'), '265');
    fireEvent.press(screen.getAllByText('Update ask').at(-1)!);
    await waitFor(() => expect(m.updateStockxAsk).toHaveBeenCalledWith('l1', '265.00'));

    fireEvent.press(await screen.findByText('Remove'));
    m.removeStockxAsk.mockResolvedValueOnce({ ...LISTING, status: 'deleted' });
    await act(async () => { await pressAlertButton('Remove'); });
    expect(m.removeStockxAsk).toHaveBeenCalledWith('l1');
    fireEvent.press(screen.getByText('Remove'));
    m.removeStockxAsk.mockRejectedValueOnce(new Error('502'));
    await act(async () => { await pressAlertButton('Remove'); });
    expect(Alert.alert).toHaveBeenCalledWith('Could not remove ask', '502');
  });

  it('closes the ask sheet on cancel and shows pending asks', async () => {
    m.getStockxItem.mockResolvedValue({ links: [{ product_id: 'p1', variant_id: null, size: null }], listings: [] });
    m.getStockxMarket.mockResolvedValue([]);
    render(<StockxItemCard itemId="i1" />);
    expect(await screen.findByText('Size -')).toBeTruthy();
    fireEvent.press(screen.getByText('Place ask'));
    fireEvent.press(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByText(FEE_DISCLAIMER)).toBeNull());
  });

  it('marks pending asks', async () => {
    m.getStockxItem.mockResolvedValue({ links: [LINK], listings: [{ ...LISTING, status: 'pending' }] });
    m.getStockxMarket.mockResolvedValue([]);
    render(<StockxItemCard itemId="i1" />);
    expect(await screen.findByText(/\(pending\)/)).toBeTruthy();
    expect(screen.getByText('Re-match on StockX')).toBeTruthy();
  });
});
