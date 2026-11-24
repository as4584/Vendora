import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as apiMock from '../services/api';
import ImportSalesScreen from '../app/(tabs)/settings/import-sales';

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('../services/api', () => ({ importSalesCsv: jest.fn() }));

const FILE = { uri: 'file:///sales.csv', name: 'sales.csv', mimeType: 'text/csv' };
const PREVIEW: apiMock.SalesImportResult = {
  platform: 'mercari', dry_run: true, columns: {}, rows: 5, new_sales: 4, duplicates: 1, imported: 0,
  gross_total: '210.00', fee_total: '27.30', missing_dates: 0, errors: [{ row: 6, reason: 'No sale price.' }],
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({ canceled: false, assets: [FILE] });
});

it('previews a file for the chosen platform, then imports it', async () => {
  (apiMock.importSalesCsv as jest.Mock)
    .mockResolvedValueOnce(PREVIEW)
    .mockResolvedValueOnce({ ...PREVIEW, dry_run: false, imported: 4 });
  const screen = render(<ImportSalesScreen />);
  fireEvent.press(screen.getByText('Mercari'));
  await act(async () => { fireEvent.press(screen.getByText('Choose CSV file')); });
  expect(apiMock.importSalesCsv).toHaveBeenCalledWith(FILE, 'mercari', true);
  expect(screen.getByText('4 new sales')).toBeTruthy();
  expect(screen.getByText('$210.00 sold · $27.30 in fees')).toBeTruthy();
  expect(screen.getByText('1 already imported, skipped.')).toBeTruthy();
  expect(screen.getByText('Row 6: No sale price.')).toBeTruthy();
  fireEvent.press(screen.getByText('Import 4 sales'));
  await waitFor(() => expect(apiMock.importSalesCsv).toHaveBeenLastCalledWith(FILE, 'mercari', false));
  await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Sales imported', expect.stringContaining('4 sales')));
});

it('re-previews when the platform changes and handles nothing new', async () => {
  (apiMock.importSalesCsv as jest.Mock).mockResolvedValue({ ...PREVIEW, new_sales: 0, duplicates: 5, errors: [] });
  const screen = render(<ImportSalesScreen />);
  await act(async () => { fireEvent.press(screen.getByText('Choose CSV file')); });
  expect(screen.getByText('No new sales to import')).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByText('Whatnot')); });
  expect(apiMock.importSalesCsv).toHaveBeenLastCalledWith(FILE, 'whatnot', true);
});

it('shows read errors', async () => {
  (apiMock.importSalesCsv as jest.Mock).mockRejectedValue(new Error('bad file'));
  const screen = render(<ImportSalesScreen />);
  await act(async () => { fireEvent.press(screen.getByText('Choose CSV file')); });
  expect(Alert.alert).toHaveBeenCalledWith("Couldn't read that file", 'bad file');
});
