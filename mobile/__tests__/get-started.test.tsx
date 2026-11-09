import { fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GetStarted } from '../components/GetStarted';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('../services/api', () => ({
  getEbayStatus: jest.fn(() => Promise.resolve({ connected: false })),
  getStockxStatus: jest.fn(() => Promise.resolve({ connected: false })),
}));

beforeEach(async () => { mockPush.mockClear(); await AsyncStorage.clear(); });

it('shows progress and routes to the next step', async () => {
  const { findByTestId, getByText } = render(<GetStarted userId="u1" totalItems={2} itemsSold={0} />);
  await findByTestId('get-started');
  getByText('Get started · 1 of 3');
  fireEvent.press(await findByTestId('get-started-sale'));
  expect(mockPush).toHaveBeenCalledWith('/inventory/sale');
});

it('hides once dismissed and stays hidden', async () => {
  const first = render(<GetStarted userId="u1" totalItems={0} itemsSold={0} />);
  fireEvent.press(await first.findByTestId('get-started-dismiss'));
  expect(first.queryByTestId('get-started')).toBeNull();
  first.unmount();
  const again = render(<GetStarted userId="u1" totalItems={0} itemsSold={0} />);
  await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
  expect(again.queryByTestId('get-started')).toBeNull();
});

it('hides when every step is done', async () => {
  const api = require('../services/api');
  api.getEbayStatus.mockResolvedValueOnce({ connected: true });
  const r = render(<GetStarted userId="u2" totalItems={3} itemsSold={1} />);
  await waitFor(() => expect(api.getEbayStatus).toHaveBeenCalled());
  await waitFor(() => expect(r.queryByTestId('get-started')).toBeNull());
});
