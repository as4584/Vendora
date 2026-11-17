import React from 'react';
import { Alert, Linking } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import BatchScanScreen from '../app/(tabs)/inventory/batch-scan';

const mockReplace = jest.fn();
const mockRequest = jest.fn();
let mockPermission: { granted: boolean; canAskAgain: boolean } | null = { granted: true, canAskAgain: true };

jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace, push: jest.fn() }) }));
jest.mock('expo-camera', () => {
  const { View } = require('react-native');
  const R = require('react');
  return {
    useCameraPermissions: () => [mockPermission, mockRequest],
    CameraView: (props: object) => R.createElement(View, props),
  };
});
jest.mock('../services/api', () => ({
  listItems: jest.fn(),
  createItem: jest.fn(),
  updateItem: jest.fn(),
}));
jest.mock('../services/smartScan', () => ({
  resolveScan: jest.fn(),
  rememberScan: jest.fn(() => Promise.resolve()),
}));

const api = jest.requireMock('../services/api');
const scan = jest.requireMock('../services/smartScan');
const PANDA = { name: 'Nike Dunk Low Panda', category: 'Sneakers', sku: 'DD1391-100', size: '10' };

beforeEach(() => {
  jest.clearAllMocks();
  mockPermission = { granted: true, canAskAgain: true };
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  api.listItems.mockResolvedValue({ items: [] });
  api.createItem.mockResolvedValue({ id: 'new' });
  api.updateItem.mockResolvedValue({ id: 'old' });
  scan.resolveScan.mockImplementation(async (code: string) =>
    code === '111' ? { barcode: code, match: 'memory', fields: PANDA, times_seen: 2 } : { barcode: code, match: null, fields: {}, times_seen: 0 },
  );
});

async function scanCode(s: ReturnType<typeof render>, data: string) {
  await act(async () => {
    await s.getByTestId('batch-camera').props.onBarcodeScanned({ data });
  });
}

it('scans boxes, names the unknown one in review, applies cost, and saves', async () => {
  const s = render(<BatchScanScreen />);
  expect(s.getByText('Scan a box to start')).toBeTruthy();
  await scanCode(s, '111');
  await scanCode(s, '222');
  expect(s.getByText('Nike Dunk Low Panda')).toBeTruthy();
  expect(s.getByText('New item · name it in review')).toBeTruthy();
  expect(s.getByText('2 scanned · keep going')).toBeTruthy();

  fireEvent.press(s.getByTestId('batch-review'));
  fireEvent.press(s.getByTestId('batch-save'));
  expect(Alert.alert).toHaveBeenCalledWith('Name every new item', '1 box still needs a name.');

  fireEvent.changeText(s.getByLabelText('Name for 222'), 'Mystery Yeezy');
  fireEvent.changeText(s.getByLabelText('Cost for every box'), '110');
  fireEvent.press(s.getByText('Apply to all'));
  await act(async () => { fireEvent.press(s.getByTestId('batch-save')); });

  expect(api.createItem).toHaveBeenCalledTimes(2);
  expect(api.createItem).toHaveBeenCalledWith(expect.objectContaining({ name: 'Mystery Yeezy', upc: '222', buy_price: '110' }));
  expect(scan.rememberScan).toHaveBeenCalledWith('111', expect.objectContaining({ name: 'Nike Dunk Low Panda' }), expect.any(Object));
  expect(Alert.alert).toHaveBeenLastCalledWith('Saved', '2 new items.');
  expect(mockReplace).toHaveBeenCalledWith('/inventory');
});

it('restocks an item already in inventory and adjusts quantities', async () => {
  api.listItems.mockResolvedValueOnce({ items: [{ id: 'old', name: 'Panda (stock)', quantity: 2, size: '10', custom_attributes: null }] });
  const s = render(<BatchScanScreen />);
  await scanCode(s, '111');
  expect(s.getByText('Already in stock (2). Add to it')).toBeTruthy();
  fireEvent.press(s.getByLabelText('More 111'));
  fireEvent.press(s.getByLabelText('More 111'));
  fireEvent.press(s.getByLabelText('Fewer 111'));
  fireEvent.press(s.getByTestId('batch-review'));
  await act(async () => { fireEvent.press(s.getByTestId('batch-save')); });
  expect(api.updateItem).toHaveBeenCalledWith('old', { quantity: 4, expected_quantity: 2 });
  expect(Alert.alert).toHaveBeenLastCalledWith('Saved', '1 restocked.');
});

it('repeat scans of a tray box count without another lookup', async () => {
  const now = jest.spyOn(Date, 'now');
  now.mockReturnValue(1_000);
  const s = render(<BatchScanScreen />);
  await scanCode(s, '111');
  now.mockReturnValue(1_100);
  await scanCode(s, '111'); // camera repeat, ignored
  now.mockReturnValue(5_000);
  await scanCode(s, '111');
  expect(scan.resolveScan).toHaveBeenCalledTimes(1);
  expect(s.getByText('Review 2 boxes')).toBeTruthy();
  now.mockRestore();
});

it('keeps failed boxes in the list and can go back to scanning', async () => {
  api.createItem.mockRejectedValueOnce(new Error('offline'));
  scan.resolveScan.mockRejectedValueOnce(new Error('memory down'));
  api.listItems.mockRejectedValueOnce(new Error('x'));
  const s = render(<BatchScanScreen />);
  await scanCode(s, '111');
  fireEvent.press(s.getByTestId('batch-review'));
  fireEvent.changeText(s.getByLabelText('Name for 111'), 'Panda');
  await act(async () => { fireEvent.press(s.getByTestId('batch-save')); });
  await waitFor(() => expect(Alert.alert).toHaveBeenLastCalledWith("Some boxes didn't save", '1 left in the list. Check them and try again.'));
  fireEvent.press(s.getByText('Keep scanning'));
  expect(s.getByTestId('batch-camera')).toBeTruthy();
});

it('handles camera permission', async () => {
  mockPermission = { granted: false, canAskAgain: true };
  const s = render(<BatchScanScreen />);
  expect(mockRequest).toHaveBeenCalled();
  fireEvent.press(s.getByText('Allow camera'));
  mockPermission = { granted: false, canAskAgain: false };
  const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
  s.rerender(<BatchScanScreen />);
  fireEvent.press(s.getByText('Open Settings'));
  expect(open).toHaveBeenCalled();
});
