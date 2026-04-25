jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}));

jest.mock('../services/api', () => ({
  previewInventoryImport: jest.fn(),
  commitInventoryImport: jest.fn(),
}));

import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as apiMock from '../services/api';
import InventoryImportScreen from '../app/(tabs)/inventory/import';

describe('InventoryImportScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('previews a chosen csv file and shows the import summary', async () => {
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ name: 'inventory.csv', uri: 'file:///tmp/inventory.csv', mimeType: 'text/csv' }],
    });
    (apiMock.previewInventoryImport as jest.Mock).mockResolvedValue({
      job_id: 'job-1',
      filename: 'inventory.csv',
      status: 'previewed',
      total_rows: 2,
      rows_to_create: 1,
      rows_to_update: 1,
      rows_errored: 0,
      rows: [
        { row_number: 1, action: 'create', match_key: null, match_value: null, error_message: null, mapped_data: { name: 'Jordan 1' } },
        { row_number: 2, action: 'update', match_key: 'sku', match_value: 'J1-001', error_message: null, mapped_data: { name: 'Yeezy 350' } },
      ],
    });

    const screen = render(<InventoryImportScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText('Choose CSV File'));
    });

    await waitFor(() => {
      expect(screen.getByText('Preview Summary')).toBeTruthy();
      expect(screen.getByText('Selected: inventory.csv')).toBeTruthy();
      expect(screen.getByText('Create 1')).toBeTruthy();
      expect(screen.getByText('Update 1')).toBeTruthy();
    });
  });

  it('commits a previewed import job', async () => {
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ name: 'inventory.csv', uri: 'file:///tmp/inventory.csv', mimeType: 'text/csv' }],
    });
    (apiMock.previewInventoryImport as jest.Mock).mockResolvedValue({
      job_id: 'job-22',
      filename: 'inventory.csv',
      status: 'previewed',
      total_rows: 1,
      rows_to_create: 1,
      rows_to_update: 0,
      rows_errored: 0,
      rows: [
        { row_number: 1, action: 'create', match_key: null, match_value: null, error_message: null, mapped_data: { name: 'Jordan 1' } },
      ],
    });
    (apiMock.commitInventoryImport as jest.Mock).mockResolvedValue({
      status: 'committed',
      rows_created: 1,
      rows_updated: 0,
      rows_skipped: 0,
      rows_errored: 0,
    });

    const screen = render(<InventoryImportScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText('Choose CSV File'));
    });

    await waitFor(() => {
      expect(screen.getByText('Commit Import')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Commit Import'));
    });

    expect(apiMock.commitInventoryImport).toHaveBeenCalledWith('job-22');
  });
});
