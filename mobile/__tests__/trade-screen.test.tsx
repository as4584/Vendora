import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import TradeScreen from '../app/(tabs)/inventory/trade';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('../services/api', () => ({ listItems: jest.fn(), createTrade: jest.fn() }));
jest.mock('../components/Button', () => {
  const { Pressable, Text } = require('react-native');
  return {
    triggerHaptic: jest.fn(),
    Button: ({ label, onPress, testID }: any) => <Pressable testID={testID} onPress={onPress}><Text>{label}</Text></Pressable>,
    IconButton: ({ label, onPress }: any) => <Pressable accessibilityLabel={label} onPress={onPress} />,
  };
});

const api = apiMock as jest.Mocked<typeof apiMock>;
const FOURS = { id: 'a', name: 'Jordan 4 Black Cat', size: '10', buy_price: '150.00', expected_sell_price: '250.00' } as any;

async function pickFours(screen: ReturnType<typeof render>) {
  fireEvent.changeText(screen.getByLabelText('Search your inventory for a pair to give'), 'jordan');
  await act(async () => { jest.advanceTimersByTime(250); });
  await waitFor(() => screen.getByLabelText('Give Jordan 4 Black Cat'));
  fireEvent.press(screen.getByLabelText('Give Jordan 4 Black Cat'));
}

describe('trade screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    api.listItems.mockResolvedValue({ items: [FOURS], total: 1, page: 1, per_page: 8, pages: 1 } as any);
    api.createTrade.mockResolvedValue({
      id: 't', order_id: 'o', value_out: '250.00', value_in: '220.00', cash_amount: '30.00',
      cash_method: 'cash', profit: '100.00', transaction_ids: ['x'], received_item_ids: ['y'], created_at: null,
    });
  });
  afterEach(() => jest.useRealTimers());

  it('balances a pair-for-pair trade with cash and records it', async () => {
    const screen = render(<TradeScreen />);
    await pickFours(screen);
    expect(api.listItems).toHaveBeenCalledWith({ q: 'jordan', perPage: 8, availableOnly: true });
    fireEvent.changeText(screen.getByLabelText('Name of pair 1 you get'), 'Jordan 11 Concord');
    fireEvent.changeText(screen.getByLabelText('Size of pair 1 you get'), '10.5');
    fireEvent.changeText(screen.getByLabelText('Trade value of pair 1 you get'), '220');

    expect(screen.getByText('They pay you $30.00')).toBeTruthy();
    expect(screen.getByText('Profit on pairs you give: $100.00')).toBeTruthy();
    expect(screen.getByText('Goes into inventory at cost $220.00')).toBeTruthy();

    fireEvent.press(screen.getByText('Venmo'));
    await act(async () => { fireEvent.press(screen.getByTestId('record-trade')); });
    expect(api.createTrade).toHaveBeenCalledWith({
      give: [{ item_id: 'a', value: '250.00', size: '10' }],
      get: [{ name: 'Jordan 11 Concord', value: '220.00', size: '10.5' }],
      cash_amount: '30.00', cash_method: 'venmo',
    });
    expect(screen.getByText('Trade recorded')).toBeTruthy();
    fireEvent.press(screen.getByText('View inventory'));
    expect(mockPush).toHaveBeenCalledWith('/inventory');
  });

  it('lets the seller pay cash on top, then return to auto', async () => {
    const screen = render(<TradeScreen />);
    await pickFours(screen);
    fireEvent.changeText(screen.getByLabelText('Name of pair 1 you get'), 'Travis 1');
    fireEvent.changeText(screen.getByLabelText('Trade value of pair 1 you get'), '300');
    expect(screen.getByText('You pay $50.00')).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText('Cash amount'), '40');
    expect(screen.getByText('You pay $40.00')).toBeTruthy();
    expect(screen.getByText('New pairs cost you $290.00 in total')).toBeTruthy();
    fireEvent.press(screen.getByText('They pay me'));
    expect(screen.getByText('They pay you $40.00')).toBeTruthy();
    fireEvent.press(screen.getByText('Auto'));
    expect(screen.getByText('You pay $50.00')).toBeTruthy();
    fireEvent.press(screen.getByText('I pay them'));
    expect(screen.getByText('You pay $50.00')).toBeTruthy();
  });

  it('shows why an unbalanced trade cannot be saved, and server errors', async () => {
    const screen = render(<TradeScreen />);
    await act(async () => { fireEvent.press(screen.getByTestId('record-trade')); });
    expect(screen.getByText("Add a pair you're giving or getting.")).toBeTruthy();
    expect(api.createTrade).not.toHaveBeenCalled();

    await pickFours(screen);
    api.createTrade.mockRejectedValueOnce(new Error('Only 0 unit(s) of Jordan 4 Black Cat available.'));
    fireEvent.changeText(screen.getByLabelText('Name of pair 1 you get'), 'Dunk');
    fireEvent.changeText(screen.getByLabelText('Trade value of pair 1 you get'), '250');
    await act(async () => { fireEvent.press(screen.getByTestId('record-trade')); });
    expect(screen.getByText(/Only 0 unit/)).toBeTruthy();
  });

  it('edits and removes rows, adds pairs, and survives a failed search', async () => {
    const screen = render(<TradeScreen />);
    await pickFours(screen);
    fireEvent.changeText(screen.getByLabelText('Trade value for Jordan 4 Black Cat'), '200');
    fireEvent.press(screen.getByText('Add another pair'));
    expect(screen.getByLabelText('Name of pair 2 you get')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Remove pair 2 you get'));
    fireEvent.press(screen.getByLabelText('Remove Jordan 4 Black Cat'));
    expect(screen.queryByLabelText('Trade value for Jordan 4 Black Cat')).toBeNull();

    api.listItems.mockRejectedValueOnce(new Error('offline'));
    fireEvent.changeText(screen.getByLabelText('Search your inventory for a pair to give'), 'x');
    await act(async () => { jest.advanceTimersByTime(250); });
    expect(screen.queryByLabelText('Give Jordan 4 Black Cat')).toBeNull();
    fireEvent.changeText(screen.getByLabelText('Search your inventory for a pair to give'), '');
    await act(async () => { jest.advanceTimersByTime(250); });
  });

  it('marks a trade saved offline as pending', async () => {
    api.createTrade.mockResolvedValueOnce({
      id: 't', order_id: 'o', value_out: '0.00', value_in: '90.00', cash_amount: '-70.00', cash_method: 'cash',
      profit: null, transaction_ids: [], received_item_ids: [], created_at: null, pending: true,
    });
    const screen = render(<TradeScreen />);
    fireEvent.changeText(screen.getByLabelText('Name of pair 1 you get'), 'Panda Dunk');
    fireEvent.changeText(screen.getByLabelText('Trade value of pair 1 you get'), '90');
    fireEvent.changeText(screen.getByLabelText('Cash amount'), '70');
    await act(async () => { fireEvent.press(screen.getByTestId('record-trade')); });
    expect(screen.getByText(/syncs when you're back online/)).toBeTruthy();
  });
});
