import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import { UnknownBarcodeSheet } from '../components/UnknownBarcodeSheet';
import { LinkedBarcodes } from '../components/LinkedBarcodes';

jest.mock('../services/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiError,
    listItems: jest.fn(),
    linkBarcode: jest.fn(),
    unlinkBarcode: jest.fn(),
    listItemBarcodes: jest.fn(),
  };
});

const ITEM = { id: 'i1', name: 'Dunk Low Panda', size: '10', sku: 'DD1391', quantity: 2 };

describe('UnknownBarcodeSheet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    (apiMock.listItems as jest.Mock).mockResolvedValue({ items: [ITEM] });
  });
  afterEach(() => jest.restoreAllMocks());

  const props = () => ({
    onClose: jest.fn(), onLinked: jest.fn(), onAddNew: jest.fn(), onMakeRule: jest.fn(),
  });

  it('renders nothing without a code', () => {
    const screen = render(<UnknownBarcodeSheet code={null} {...props()} />);
    expect(screen.queryByTestId('unknown-barcode-sheet')).toBeNull();
  });

  it('searches stock and offers to move a code linked elsewhere', async () => {
    const p = props();
    const screen = render(<UnknownBarcodeSheet code="TAG-1" {...p} />);
    expect(await screen.findByText('Size 10 · DD1391 · 2 left')).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('unknown-barcode-search'), 'panda');
    await waitFor(() => expect(apiMock.listItems).toHaveBeenLastCalledWith({ q: 'panda', perPage: 8, availableOnly: true }));

    const { ApiError } = jest.requireMock('../services/api');
    (apiMock.linkBarcode as jest.Mock).mockRejectedValueOnce(new ApiError('This barcode is already linked to Old.', 409));
    await act(async () => fireEvent.press(screen.getByLabelText('Link to Dunk Low Panda')));
    const [title, , buttons] = (Alert.alert as jest.Mock).mock.calls.at(-1);
    expect(title).toBe('Barcode already linked');
    (apiMock.linkBarcode as jest.Mock).mockResolvedValueOnce({ code: 'TAG-1', inventory_item_id: 'i1' });
    await act(async () => buttons[1].onPress());
    expect(apiMock.linkBarcode).toHaveBeenLastCalledWith('i1', 'TAG-1', true);
    expect(p.onLinked).toHaveBeenCalledWith(ITEM);
  });

  it('reports link failures and empty or failed searches', async () => {
    (apiMock.listItems as jest.Mock).mockRejectedValueOnce(new Error('down'));
    const screen = render(<UnknownBarcodeSheet code="TAG-2" {...props()} />);
    await waitFor(() => expect(apiMock.listItems).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('No matching items.')).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('unknown-barcode-search'), 'x');
    await screen.findByLabelText('Link to Dunk Low Panda');
    (apiMock.linkBarcode as jest.Mock).mockRejectedValueOnce(new Error('boom'));
    await act(async () => fireEvent.press(screen.getByLabelText('Link to Dunk Low Panda')));
    expect(Alert.alert).toHaveBeenCalledWith("Couldn't link barcode", 'boom');

    screen.rerender(<UnknownBarcodeSheet code="TAG-3" {...props()} />);
    expect(screen.getByTestId('unknown-barcode-search').props.value).toBe('');
    screen.rerender(<UnknownBarcodeSheet code={null} {...props()} />);
  });
});

describe('LinkedBarcodes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('lists, adds and removes store barcodes', async () => {
    (apiMock.listItemBarcodes as jest.Mock).mockResolvedValue([{ code: 'SHELF-9', inventory_item_id: 'i1' }]);
    const screen = render(<LinkedBarcodes itemId="i1" />);
    expect(await screen.findByText('SHELF-9')).toBeTruthy();

    fireEvent.press(screen.getByText('Link'));
    expect(apiMock.linkBarcode).not.toHaveBeenCalled();
    (apiMock.linkBarcode as jest.Mock).mockResolvedValueOnce({ code: 'NEW-1', inventory_item_id: 'i1' });
    fireEvent.changeText(screen.getByTestId('linked-barcode-input'), 'new-1');
    await act(async () => fireEvent.press(screen.getByText('Link')));
    expect(apiMock.linkBarcode).toHaveBeenCalledWith('i1', 'new-1');
    expect(screen.getByText('NEW-1')).toBeTruthy();
    (apiMock.linkBarcode as jest.Mock).mockResolvedValueOnce({ code: 'NEW-1', inventory_item_id: 'i1' });
    fireEvent.changeText(screen.getByTestId('linked-barcode-input'), 'NEW-1');
    await act(async () => fireEvent(screen.getByTestId('linked-barcode-input'), 'submitEditing'));
    expect(screen.getAllByText('NEW-1')).toHaveLength(1);

    (apiMock.linkBarcode as jest.Mock).mockRejectedValueOnce(new Error('taken'));
    fireEvent.changeText(screen.getByTestId('linked-barcode-input'), 'X');
    await act(async () => fireEvent.press(screen.getByText('Link')));
    expect(Alert.alert).toHaveBeenCalledWith("Couldn't link barcode", 'taken');

    (apiMock.unlinkBarcode as jest.Mock).mockResolvedValueOnce(undefined);
    await act(async () => fireEvent.press(screen.getByLabelText('Remove SHELF-9')));
    expect(screen.queryByText('SHELF-9')).toBeNull();
    (apiMock.unlinkBarcode as jest.Mock).mockRejectedValueOnce(new Error('nope'));
    await act(async () => fireEvent.press(screen.getByLabelText('Remove NEW-1')));
    expect(Alert.alert).toHaveBeenCalledWith("Couldn't remove barcode", 'nope');
  });

  it('ignores a failed load and a late response after unmount', async () => {
    (apiMock.listItemBarcodes as jest.Mock).mockRejectedValueOnce(new Error('down'));
    const screen = render(<LinkedBarcodes itemId="i2" />);
    await waitFor(() => expect(apiMock.listItemBarcodes).toHaveBeenCalled());
    screen.unmount();
    let resolve: (v: unknown) => void = () => undefined;
    (apiMock.listItemBarcodes as jest.Mock).mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const second = render(<LinkedBarcodes itemId="i3" />);
    second.unmount();
    await act(async () => resolve([{ code: 'LATE', inventory_item_id: 'i3' }]));
  });
});
