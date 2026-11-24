import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import AddCostsScreen, { parseCost } from '../app/(tabs)/inventory/add-costs';

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  useFocusEffect: (cb: () => void) => { const R = require('react'); R.useEffect(cb, []); },
}));
jest.mock('../services/api', () => ({ listItems: jest.fn(), updateItem: jest.fn() }));

const item = (id: string, name: string) => ({ id, name, expected_sell_price: '50.00', buy_price: null });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

it('parses costs', () => {
  expect(parseCost('$1,250.50')).toBe(1250.5);
  expect(parseCost('')).toBeNull();
  expect(parseCost('-1')).toBeNull();
  expect(parseCost('abc')).toBeNull();
});

it('lists items missing a cost and saves only filled rows, with use-for-all', async () => {
  (apiMock.listItems as jest.Mock)
    .mockResolvedValueOnce({ items: [item('a', 'Tee'), item('b', 'Lamp'), item('c', 'Mug')], total: 3 })
    .mockResolvedValue({ items: [], total: 0 });
  (apiMock.updateItem as jest.Mock).mockResolvedValue({});
  const screen = render(<AddCostsScreen />);
  await screen.findByText('Tee');
  expect(apiMock.listItems).toHaveBeenCalledWith({ page: 1, perPage: 100, missingCost: true });
  fireEvent.changeText(screen.getByLabelText('Cost for Tee'), '5');
  fireEvent.press(screen.getByText('Use this cost for all blank items'));
  fireEvent.changeText(screen.getByLabelText('Cost for Mug'), '');
  fireEvent.press(screen.getByText('Save 2 costs'));
  await waitFor(() => expect(apiMock.updateItem).toHaveBeenCalledTimes(2));
  expect(apiMock.updateItem).toHaveBeenCalledWith('a', { buy_price: '5' });
  expect(apiMock.updateItem).toHaveBeenCalledWith('b', { buy_price: '5' });
  await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Saved', expect.stringContaining('2 items')));
  await screen.findByText('Every item has a cost. Profit is accurate.');
});

it('blocks saving invalid amounts', async () => {
  (apiMock.listItems as jest.Mock).mockResolvedValue({ items: [item('a', 'Tee'), item('b', 'Lamp')], total: 2 });
  const screen = render(<AddCostsScreen />);
  await screen.findByText('Tee');
  fireEvent.changeText(screen.getByLabelText('Cost for Tee'), '5');
  fireEvent.changeText(screen.getByLabelText('Cost for Lamp'), 'abc');
  fireEvent.press(screen.getByText('Save 1 cost'));
  expect(Alert.alert).toHaveBeenCalledWith('Check the costs', "1 cost isn't a valid amount.");
  expect(apiMock.updateItem).not.toHaveBeenCalled();
});
