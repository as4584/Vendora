import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import AgingScreen from '../app/(tabs)/inventory/aging';
import { AgingCard } from '../components/AgingCard';
import { markdownPrice } from '../utils/aging';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: mockPush }),
  useFocusEffect: (cb: () => void) => { const R = require('react'); R.useEffect(cb, []); },
}));
jest.mock('../services/api', () => ({ getAgingStock: jest.fn(), updateItem: jest.fn() }));

const DATA: apiMock.AgingStock = {
  days: 60, count: 2,
  items: [
    { id: 'a', name: 'Lamp', expected_sell_price: '40.00', buy_price: '10.00', days_old: 92 },
    { id: 'b', name: 'Tee', expected_sell_price: '12.00', buy_price: '11.50', days_old: 64 },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

describe('markdownPrice', () => {
  it('drops by percent, floors at cost, and skips missing or unchanged prices', () => {
    expect(markdownPrice('40.00', 10)).toBe('36.00');
    expect(markdownPrice('12.00', 10, '11.50')).toBe('11.50');
    expect(markdownPrice('11.50', 10, '11.50')).toBeNull();
    expect(markdownPrice(null, 10)).toBeNull();
  });
});

describe('AgingCard', () => {
  it('shows the count and opens the aging screen', async () => {
    (apiMock.getAgingStock as jest.Mock).mockResolvedValue(DATA);
    const screen = render(<AgingCard />);
    fireEvent.press(await screen.findByText('2 items have sat 60+ days'));
    expect(mockPush).toHaveBeenCalledWith('/inventory/aging');
  });

  it('is hidden when nothing is aging', async () => {
    (apiMock.getAgingStock as jest.Mock).mockResolvedValue({ days: 60, count: 0, items: [] });
    const screen = render(<AgingCard />);
    await waitFor(() => expect(apiMock.getAgingStock).toHaveBeenCalled());
    expect(screen.toJSON()).toBeNull();
  });
});

describe('AgingScreen', () => {
  it('drops all prices by the chosen percent, never below cost', async () => {
    (apiMock.getAgingStock as jest.Mock).mockResolvedValue(DATA);
    (apiMock.updateItem as jest.Mock).mockResolvedValue({});
    const screen = render(<AgingScreen />);
    await screen.findByText('Lamp');
    expect(screen.getByText('92 days · $40.00 → $36.00')).toBeTruthy();
    fireEvent.press(screen.getByText('20% off'));
    fireEvent.press(screen.getByText('Drop all 20%'));
    await waitFor(() => expect(apiMock.updateItem).toHaveBeenCalledTimes(2));
    expect(apiMock.updateItem).toHaveBeenCalledWith('a', { expected_sell_price: '32.00' });
    expect(apiMock.updateItem).toHaveBeenCalledWith('b', { expected_sell_price: '11.50' });
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Prices dropped', '2 items now 20% lower.'));
  });

  it('drops a single item', async () => {
    (apiMock.getAgingStock as jest.Mock).mockResolvedValue(DATA);
    (apiMock.updateItem as jest.Mock).mockResolvedValue({});
    const screen = render(<AgingScreen />);
    await screen.findByText('Lamp');
    fireEvent.press(screen.getAllByText('-10%')[0]);
    await waitFor(() => expect(apiMock.updateItem).toHaveBeenCalledWith('a', { expected_sell_price: '36.00' }));
    expect(apiMock.updateItem).toHaveBeenCalledTimes(1);
  });
});
