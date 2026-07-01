import React from 'react';
import { Alert, Platform } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as apiMock from '../services/api';
import InventoryImportScreen from '../app/(tabs)/inventory/import';

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
  importInventoryFromLink: jest.fn(),
}));

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

  it('previews a spreadsheet link and confirms the result', async () => {
    (apiMock.importInventoryFromLink as jest.Mock).mockResolvedValue({
      dry_run: true,
      rows_seen: 40,
      rows_importable: 40,
      created: 40,
      updated: 0,
      skipped: 0,
      errors: [],
      warnings: [],
      sample_items: [
        { name: 'The Cotton Wreath Hoodie Black', photo_front_url: 'data:image/jpeg;base64,abc' },
      ],
    });

    const screen = render(<InventoryImportScreen />);

    fireEvent.changeText(
      screen.getByPlaceholderText('https://docs.google.com/spreadsheets/d/...'),
      'https://docs.google.com/spreadsheets/d/example/edit?gid=0#gid=0'
    );

    await act(async () => {
      fireEvent.press(screen.getByText('Preview Link'));
    });

    await waitFor(() => {
      expect(apiMock.importInventoryFromLink).toHaveBeenCalledWith(
        'https://docs.google.com/spreadsheets/d/example/edit?gid=0#gid=0',
        true
      );
      expect(Alert.alert).toHaveBeenCalledWith(
        'Preview ready',
        expect.stringContaining('40 items found')
      );
      expect(screen.getByText('Importable 40')).toBeTruthy();
      expect(screen.getByText('The Cotton Wreath Hoodie Black')).toBeTruthy();
    });
  });

  it('ignores a canceled picker and reports preview failures', async () => {
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({ canceled: true });
    const screen = render(<InventoryImportScreen />);
    fireEvent.press(screen.getByText('Choose CSV File'));
    await waitFor(() => expect(DocumentPicker.getDocumentAsync).toHaveBeenCalled());
    expect(apiMock.previewInventoryImport).not.toHaveBeenCalled();

    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ name: 'bad.xlsx', uri: 'file:///bad.xlsx' }],
    });
    (apiMock.previewInventoryImport as jest.Mock).mockRejectedValueOnce(new Error('invalid sheet'));
    fireEvent.press(screen.getByText('Choose CSV File'));
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith('Import preview failed', 'invalid sheet'),
    );
  });

  it('loads browser-selected files as blobs before previewing', async () => {
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      blob: jest.fn().mockResolvedValue(new Blob(['name\nJordan'], { type: 'text/csv' })),
    } as unknown as Response);
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ name: 'browser.csv', uri: 'blob:browser', mimeType: 'text/csv' }],
    });
    (apiMock.previewInventoryImport as jest.Mock).mockResolvedValue({
      job_id: 'web-job',
      filename: 'browser.csv',
      status: 'previewed',
      total_rows: 0,
      rows_to_create: 0,
      rows_to_update: 0,
      rows_errored: 0,
      rows: [],
    });
    try {
      const screen = render(<InventoryImportScreen />);
      fireEvent.press(screen.getByText('Choose CSV File'));
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('blob:browser'));
      expect(apiMock.previewInventoryImport).toHaveBeenCalledWith(expect.any(FormData));
    } finally {
      fetchSpy.mockRestore();
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    }
  });

  it('reports commit failures after a successful preview', async () => {
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ name: 'inventory.csv', uri: 'file:///inventory.csv', mimeType: 'text/csv' }],
    });
    (apiMock.previewInventoryImport as jest.Mock).mockResolvedValue({
      job_id: 'job-fail',
      filename: null,
      status: 'previewed',
      total_rows: 1,
      rows_to_create: 0,
      rows_to_update: 0,
      rows_errored: 1,
      rows: [
        {
          row_number: 1,
          action: 'error',
          error_message: 'Name missing',
          mapped_data: null,
          match_value: null,
        },
      ],
    });
    (apiMock.commitInventoryImport as jest.Mock).mockRejectedValueOnce(new Error('commit rejected'));
    const screen = render(<InventoryImportScreen />);
    fireEvent.press(screen.getByText('Choose CSV File'));
    await screen.findByText('Commit Import');
    fireEvent.press(screen.getByText('Commit Import'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Import failed', 'commit rejected'));
    expect(screen.getByText('Name missing')).toBeTruthy();
  });

  it('validates spreadsheet links and renders warnings, errors, and no-import outcomes', async () => {
    const screen = render(<InventoryImportScreen />);
    fireEvent.press(screen.getByText('Preview Link'));
    expect(Alert.alert).toHaveBeenCalledWith(
      'Spreadsheet link required',
      'Paste a read-only Google Sheets, CSV, or XLSX link first.',
    );

    (apiMock.importInventoryFromLink as jest.Mock).mockResolvedValueOnce({
      dry_run: true,
      rows_seen: 2,
      rows_importable: 0,
      created: 0,
      updated: 0,
      skipped: 2,
      errors: [{ row: 1, message: 'Invalid item' }],
      warnings: [
        { row: 1, message: 'Price missing' },
        { row: 2, message: 'Size missing and Photo missing' },
      ],
      sample_items: [{ name: null, sku: 'SKU-1', category: 'other' }],
    });
    fireEvent.changeText(screen.getByLabelText('Spreadsheet link'), ' https://example.com/items.csv ');
    fireEvent.press(screen.getByText('Preview Link'));
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'No importable items found',
        expect.stringContaining('Needs review'),
      ),
    );
    expect(screen.getByText('Row 1: Invalid item')).toBeTruthy();
    expect(screen.getByText('Row 1: Price missing')).toBeTruthy();
  });

  it('imports a spreadsheet link and reports import request failures', async () => {
    (apiMock.importInventoryFromLink as jest.Mock)
      .mockResolvedValueOnce({
        dry_run: false,
        rows_seen: 2,
        rows_importable: 2,
        created: 1,
        updated: 1,
        skipped: 0,
        errors: [],
        warnings: [],
        sample_items: [],
      })
      .mockRejectedValueOnce(new Error('link unavailable'));
    const screen = render(<InventoryImportScreen />);
    fireEvent.changeText(screen.getByLabelText('Spreadsheet link'), 'https://example.com/items.xlsx');
    fireEvent.press(screen.getByText('Import Link'));
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'Spreadsheet imported',
        '1 created, 1 updated, 0 skipped.',
      ),
    );
    fireEvent.press(screen.getByText('Import Link'));
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith('Link import failed', 'link unavailable'),
    );
  });
});
