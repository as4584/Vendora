import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import LabelsScreen from '../app/(tabs)/inventory/labels';
import { itemIdFromScan } from '../utils/labels';
import { downloadAndShareRemote } from '../utils/fileActions';

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({ useLocalSearchParams: () => mockParams }));
jest.mock('../utils/fileActions', () => ({ downloadAndShareRemote: jest.fn(async () => undefined) }));
jest.mock('../services/api', () => ({
  listItems: jest.fn(),
  getToken: jest.fn(async () => 'tok'),
  priceLabelsUrl: jest.requireActual('../services/api').priceLabelsUrl,
}));

const api = apiMock as jest.Mocked<typeof apiMock>;
const share = downloadAndShareRemote as jest.Mock;
const A = { id: 'a', name: 'Jordan 4', size: '10', expected_sell_price: '250.00', quantity: 2 } as any;
const B = { id: 'b', name: 'Dunk Low', size: null, expected_sell_price: null, quantity: 1 } as any;

async function ready() {
  const screen = render(<LabelsScreen />);
  await act(async () => { jest.advanceTimersByTime(250); });
  await waitFor(() => screen.getByLabelText('Label for Jordan 4'));
  return screen;
}

describe('label QR parsing', () => {
  it('reads only Resqlo label codes', () => {
    expect(itemIdFromScan(' resqlo:item:1b2c3d4e-0000-1111 ')).toBe('1b2c3d4e-0000-1111');
    expect(itemIdFromScan('RESQLO:ITEM:ABCDEF12')).toBe('ABCDEF12');
    expect(itemIdFromScan('resqlo:item:not an id!')).toBeNull();
    expect(itemIdFromScan('012345678905')).toBeNull();
  });
});

describe('price labels screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockParams = {};
    api.listItems.mockResolvedValue({ items: [A, B], total: 2, page: 1, per_page: 100, pages: 1 } as any);
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });
  afterEach(() => jest.useRealTimers());

  it('prints selected pairs on a label printer', async () => {
    const screen = await ready();
    expect(screen.getByText('Pick pairs to label')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Label for Jordan 4'));
    expect(screen.getByText('Print 1 label')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByTestId('print-labels')); });
    expect(share).toHaveBeenCalledWith(
      expect.stringContaining('/inventory/labels.pdf?ids=a&layout=thermal&per_unit=false'),
      'resqlo-labels.pdf', 'tok', 'application/pdf', expect.any(Function),
    );
    expect(share.mock.calls[0][4](500)).toBe('Could not make the labels (500).');
  });

  it('selects all, one per pair on an Avery sheet, and unselects', async () => {
    mockParams = { ids: 'a,zzz' };
    const screen = await ready();
    fireEvent.press(screen.getByText('Select all'));
    fireEvent.press(screen.getByText('One label per pair in stock'));
    expect(screen.getByText('Print 4 labels')).toBeTruthy(); // 2 + 1 + the preselected pair not shown
    fireEvent.press(screen.getByText('Avery sheet'));
    await act(async () => { fireEvent.press(screen.getByTestId('print-labels')); });
    expect(share.mock.calls[0][0]).toContain('ids=a%2Czzz%2Cb&layout=sheet&per_unit=true');
    fireEvent.press(screen.getByText('Clear'));
    fireEvent.press(screen.getByLabelText('Label for Jordan 4'));
    fireEvent.press(screen.getByLabelText('Label for Jordan 4'));
    expect(screen.getByText('Print 1 label')).toBeTruthy();
  });

  it('searches, handles errors and empty results', async () => {
    const screen = await ready();
    api.listItems.mockRejectedValueOnce(new Error('offline'));
    fireEvent.changeText(screen.getByLabelText('Search items to label'), 'zzz');
    await act(async () => { jest.advanceTimersByTime(250); });
    expect(api.listItems).toHaveBeenLastCalledWith({ perPage: 100, availableOnly: true, q: 'zzz' });
    expect(screen.getByText('No pairs in stock match.')).toBeTruthy();

    api.listItems.mockResolvedValueOnce({ items: [A], total: 1 } as any);
    fireEvent.changeText(screen.getByLabelText('Search items to label'), '');
    await act(async () => { jest.advanceTimersByTime(250); });
    fireEvent.press(screen.getByLabelText('Label for Jordan 4'));
    share.mockRejectedValueOnce(new Error('Could not make the labels (500).'));
    await act(async () => { fireEvent.press(screen.getByTestId('print-labels')); });
    expect(Alert.alert).toHaveBeenCalledWith('Price labels', 'Could not make the labels (500).');
  });
});
