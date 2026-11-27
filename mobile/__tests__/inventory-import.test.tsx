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

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace, push: jest.fn() }) }));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}));

jest.mock('../services/api', () => ({
  previewInventoryImport: jest.fn(),
  previewInventoryImportChunked: jest.fn(),
  commitInventoryImport: jest.fn(),
  importInventoryFromLink: jest.fn(),
  updateInventoryImportRow: jest.fn(),
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
      fireEvent.press(screen.getByText('Choose CSV or Excel File'));
    });

    await waitFor(() => {
      expect(screen.getByText('Review import')).toBeTruthy();
      expect(screen.getByText('Selected: inventory.csv')).toBeTruthy();
      expect(screen.getByText('2 items · 1 update')).toBeTruthy();
      expect(screen.getByText('New item')).toBeTruthy();
      expect(screen.getByText('Updates existing')).toBeTruthy();
      expect(screen.getByText('Add 2 items to inventory')).toBeTruthy();
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
      fireEvent.press(screen.getByText('Choose CSV or Excel File'));
    });

    await waitFor(() => {
      expect(screen.getByText('Add 1 item to inventory')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Add 1 item to inventory'));
    });

    expect(apiMock.commitInventoryImport).toHaveBeenCalledWith('job-22');
    expect(screen.getByText('1 item added')).toBeTruthy();
    expect(screen.getByText('1 new, 0 updated.')).toBeTruthy();
    fireEvent.press(screen.getByText('See my inventory'));
    expect(mockReplace).toHaveBeenCalledWith('/inventory');
    expect(screen.queryByText('Review import')).toBeNull();
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
    fireEvent.press(screen.getByText('Choose CSV or Excel File'));
    await waitFor(() => expect(DocumentPicker.getDocumentAsync).toHaveBeenCalled());
    expect(apiMock.previewInventoryImport).not.toHaveBeenCalled();

    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ name: 'bad.csv', uri: 'file:///bad.csv' }],
    });
    (apiMock.previewInventoryImport as jest.Mock).mockRejectedValueOnce(new Error('invalid sheet'));
    fireEvent.press(screen.getByText('Choose CSV or Excel File'));
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
      fireEvent.press(screen.getByText('Choose CSV or Excel File'));
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('blob:browser'));
      expect(apiMock.previewInventoryImport).toHaveBeenCalledWith(expect.any(FormData));
    } finally {
      fetchSpy.mockRestore();
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    }
  });

  it('sends files over the direct limit in chunks and shows progress', async () => {
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ name: 'huge.xlsx', uri: 'file:///huge.xlsx', size: 200 * 1024 * 1024 }],
    });
    let finish: (value: unknown) => void = () => undefined;
    let photos: (done: number, total: number) => void = () => undefined;
    let upload: (f: number) => void = () => undefined;
    (apiMock.previewInventoryImportChunked as jest.Mock).mockImplementation(
      (_file, _read, onProgress: (f: number) => void, onPhotos: (d: number, t: number) => void) => {
        upload = onProgress;
        photos = onPhotos;
        onProgress(0.5);
        return new Promise((resolve) => { finish = resolve; });
      },
    );
    const screen = render(<InventoryImportScreen />);
    fireEvent.press(screen.getByText('Choose CSV or Excel File'));
    expect(await screen.findByText('Uploading 50%...')).toBeTruthy();
    act(() => upload(1));
    expect(screen.getByText('Preparing Preview...')).toBeTruthy();
    act(() => photos(1200, 4000));
    expect(screen.getByText(`Reading photos ${(1200).toLocaleString()} of ${(4000).toLocaleString()}...`)).toBeTruthy();
    expect(apiMock.previewInventoryImport).not.toHaveBeenCalled();
    expect((apiMock.previewInventoryImportChunked as jest.Mock).mock.calls[0][0]).toEqual({
      uri: 'file:///huge.xlsx', name: 'huge.xlsx', size: 200 * 1024 * 1024,
    });
    await act(async () => {
      finish({ job_id: 'big', filename: 'huge.xlsx', status: 'previewed', total_rows: 0,
        rows_to_create: 0, rows_to_update: 0, rows_errored: 0, rows: [] });
    });
    expect(await screen.findByText('Choose CSV or Excel File')).toBeTruthy();
  });

  it('sends every Excel file through the background path, even a small one', async () => {
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ name: 'Stock.XLSX', uri: 'file:///s.xlsx', size: 2048 }],
    });
    (apiMock.previewInventoryImportChunked as jest.Mock).mockResolvedValue({
      job_id: 'small', filename: 'Stock.XLSX', status: 'previewed', total_rows: 0,
      rows_to_create: 0, rows_to_update: 0, rows_errored: 0, rows: [],
    });
    const screen = render(<InventoryImportScreen />);
    fireEvent.press(screen.getByText('Choose CSV or Excel File'));
    await waitFor(() => expect(apiMock.previewInventoryImportChunked).toHaveBeenCalled());
    expect(apiMock.previewInventoryImport).not.toHaveBeenCalled();
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
        { id: 'r2', row_number: 2, action: 'create', error_message: null, mapped_data: { name: 'Samba' }, match_value: null },
      ],
    });
    (apiMock.commitInventoryImport as jest.Mock).mockRejectedValueOnce(new Error('commit rejected'));
    const screen = render(<InventoryImportScreen />);
    fireEvent.press(screen.getByText('Choose CSV or Excel File'));
    await screen.findByText('Add 1 item to inventory');
    expect(screen.getByText('2 items · 1 needs a fix')).toBeTruthy();
    fireEvent.press(screen.getByText('Add 1 item to inventory'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Import failed', 'commit rejected'));
    expect(screen.getByText(/Row 1: Name missing/)).toBeTruthy();
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
      expect(screen.getByText('2 items imported')).toBeTruthy(),
    );
    fireEvent.press(screen.getByText('Import Link'));
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith('Link import failed', 'link unavailable'),
    );
  });
});
