import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import CatalogAdminScreen from '../app/(tabs)/settings/catalog-admin';

jest.mock('../services/api', () => ({
  searchCatalogAdmin: jest.fn(),
  updateCatalogProduct: jest.fn(),
  deleteCatalogProduct: jest.fn(),
  unlinkCatalogBarcode: jest.fn(),
}));

const P = (extra = {}) => ({
  rq_code: 'RQ-7F3K9XA', style_code: 'CU1110-010', size: '10', name: 'Jordan 4 Blak Cat',
  brand: null, category: null, color: null, times_confirmed: 2, barcodes: ['196153282201'], ...extra,
});

describe('CatalogAdminScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    (apiMock.searchCatalogAdmin as jest.Mock).mockResolvedValue([P()]);
  });
  afterEach(() => jest.restoreAllMocks());

  it('searches, edits and saves an entry for every store', async () => {
    const screen = render(<CatalogAdminScreen />);
    expect(await screen.findByText('RQ-7F3K9XA · CU1110-010 · size 10 · 2 confirmed')).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('catalog-admin-search'), 'blak');
    await waitFor(() => expect(apiMock.searchCatalogAdmin).toHaveBeenLastCalledWith('blak'));

    fireEvent.press(screen.getByLabelText('Edit Jordan 4 Blak Cat'));
    fireEvent.changeText(screen.getByLabelText('Name'), ' ');
    fireEvent.press(screen.getByText('Save for every store'));
    expect(Alert.alert).toHaveBeenCalledWith('Missing details', expect.any(String));

    fireEvent.changeText(screen.getByLabelText('Name'), 'Jordan 4 Black Cat');
    fireEvent.changeText(screen.getByLabelText('Brand'), 'Jordan');
    fireEvent.changeText(screen.getByLabelText('Size'), '');
    (apiMock.updateCatalogProduct as jest.Mock).mockRejectedValueOnce(new Error('clash'));
    await act(async () => fireEvent.press(screen.getByText('Save for every store')));
    expect(Alert.alert).toHaveBeenCalledWith("Couldn't save", 'clash');

    (apiMock.updateCatalogProduct as jest.Mock).mockResolvedValueOnce(P({ name: 'Jordan 4 Black Cat', size: null }));
    await act(async () => fireEvent.press(screen.getByText('Save for every store')));
    expect(apiMock.updateCatalogProduct).toHaveBeenLastCalledWith('RQ-7F3K9XA', {
      name: 'Jordan 4 Black Cat', style_code: 'CU1110-010', size: null, brand: 'Jordan', category: null, color: null,
    });
    expect(screen.getByText('RQ-7F3K9XA · CU1110-010 · 2 confirmed')).toBeTruthy();
  });

  it('removes a wrong barcode and deletes an entry', async () => {
    const screen = render(<CatalogAdminScreen />);
    fireEvent.press(await screen.findByLabelText('Edit Jordan 4 Blak Cat'));

    (apiMock.unlinkCatalogBarcode as jest.Mock).mockRejectedValueOnce(new Error('gone'));
    await act(async () => fireEvent.press(screen.getByLabelText('Remove 196153282201')));
    expect(Alert.alert).toHaveBeenCalledWith("Couldn't remove barcode", 'gone');
    (apiMock.unlinkCatalogBarcode as jest.Mock).mockResolvedValueOnce(undefined);
    await act(async () => fireEvent.press(screen.getByLabelText('Remove 196153282201')));
    expect(screen.getByText('No barcodes point here yet.')).toBeTruthy();

    fireEvent.press(screen.getByText('Delete this entry'));
    const buttons = (Alert.alert as jest.Mock).mock.calls.at(-1)[2];
    (apiMock.deleteCatalogProduct as jest.Mock).mockRejectedValueOnce(new Error('locked'));
    await act(async () => buttons[1].onPress());
    expect(Alert.alert).toHaveBeenCalledWith("Couldn't delete", 'locked');
    (apiMock.deleteCatalogProduct as jest.Mock).mockResolvedValueOnce(undefined);
    await act(async () => buttons[1].onPress());
    expect(apiMock.deleteCatalogProduct).toHaveBeenCalledWith('RQ-7F3K9XA');
    expect(await screen.findByText('Nothing found.')).toBeTruthy();
  });

  it('goes back from editing and reports a failed search', async () => {
    const screen = render(<CatalogAdminScreen />);
    fireEvent.press(await screen.findByLabelText('Edit Jordan 4 Blak Cat'));
    fireEvent.press(screen.getByText('Back to search'));
    expect(screen.getByTestId('catalog-admin-search')).toBeTruthy();

    (apiMock.searchCatalogAdmin as jest.Mock).mockRejectedValueOnce(new Error('down'));
    fireEvent.changeText(screen.getByTestId('catalog-admin-search'), 'x');
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith("Couldn't search the catalog", 'down'));
    screen.unmount();
  });
});
