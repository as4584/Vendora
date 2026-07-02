import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import {
  downloadAndShareRemote,
  downloadPdfFile,
  downloadTextFile,
  openPdfFile,
  previewPdfFile,
} from '../utils/fileActions';

jest.mock('expo-file-system/legacy', () => {
  let cacheDirectory: string | null = 'cache://';
  let documentDirectory: string | null = 'documents://';
  return {
    get cacheDirectory() {
      return cacheDirectory;
    },
    get documentDirectory() {
      return documentDirectory;
    },
    __setDirectories(cache: string | null, document: string | null) {
      cacheDirectory = cache;
      documentDirectory = document;
    },
    EncodingType: { UTF8: 'utf8', Base64: 'base64' },
    writeAsStringAsync: jest.fn(async () => undefined),
    downloadAsync: jest.fn(async () => ({ status: 200, uri: 'cache://vendora-inventory.xlsx' })),
  };
});

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));

const files = FileSystem as jest.Mocked<typeof FileSystem>;
const sharing = Sharing as jest.Mocked<typeof Sharing>;

describe('fileActions', () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    (FileSystem as any).__setDirectories('cache://', 'documents://');
    sharing.isAvailableAsync.mockResolvedValue(true);
  });

  afterAll(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
  });

  it('writes and shares text files on a native device', async () => {
    await downloadTextFile('id,name\n1,Jordan', 'inventory.csv');
    expect(files.writeAsStringAsync).toHaveBeenCalledWith(
      'cache://inventory.csv',
      'id,name\n1,Jordan',
      { encoding: 'utf8' },
    );
    expect(sharing.shareAsync).toHaveBeenCalledWith('cache://inventory.csv', {
      mimeType: 'text/csv;charset=utf-8',
      dialogTitle: 'inventory.csv',
    });
  });

  it('falls back to the document directory and supports a custom MIME type', async () => {
    (FileSystem as any).__setDirectories(null, 'documents://');
    await downloadTextFile('{}', 'data.json', 'application/json');
    expect(files.writeAsStringAsync).toHaveBeenCalledWith('documents://data.json', '{}', {
      encoding: 'utf8',
    });
  });

  it('reports missing native storage and sharing capabilities', async () => {
    (FileSystem as any).__setDirectories(null, null);
    await expect(downloadTextFile('x', 'x.csv')).rejects.toThrow(
      'File storage is not available on this device.',
    );

    (FileSystem as any).__setDirectories('cache://', null);
    sharing.isAvailableAsync.mockResolvedValue(false);
    await expect(downloadTextFile('x', 'x.csv')).rejects.toThrow(
      'File sharing is not available on this device.',
    );
  });

  it('writes PDFs as base64 and includes native PDF metadata', async () => {
    await downloadPdfFile('JVBERi0x', 'invoice.pdf');
    expect(files.writeAsStringAsync).toHaveBeenCalledWith('cache://invoice.pdf', 'JVBERi0x', {
      encoding: 'base64',
    });
    expect(sharing.shareAsync).toHaveBeenCalledWith('cache://invoice.pdf', {
      mimeType: 'application/pdf',
      dialogTitle: 'invoice.pdf',
      UTI: 'com.adobe.pdf',
    });
    expect(openPdfFile).toBe(previewPdfFile);
  });

  it('reports native PDF storage and sharing failures', async () => {
    (FileSystem as any).__setDirectories(null, null);
    await expect(previewPdfFile('JVBERi0x', 'invoice.pdf')).rejects.toThrow(
      'File storage is not available on this device.',
    );

    (FileSystem as any).__setDirectories(null, 'documents://');
    sharing.isAvailableAsync.mockResolvedValue(false);
    await expect(previewPdfFile('JVBERi0x', 'invoice.pdf')).rejects.toThrow(
      'PDF sharing is not available on this device.',
    );
  });

  it('downloads text and PDF blobs in the browser and revokes object URLs', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    const click = jest.fn();
    const remove = jest.fn();
    const anchor: Record<string, unknown> = { click, remove };
    const appendChild = jest.fn();
    const createElement = jest.fn(() => anchor);
    const revokeObjectURL = jest.fn();
    const createObjectURL = jest.fn(() => 'blob:vendora');
    const setTimeoutMock = jest.fn((callback: () => void) => {
      callback();
      return 1;
    });
    const originalDocument = (global as any).document;
    const originalWindow = (global as any).window;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    (global as any).document = { createElement, body: { appendChild } };
    (global as any).window = { setTimeout: setTimeoutMock };
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    try {
      await downloadTextFile('a,b', 'inventory.csv');
      expect(anchor.download).toBe('inventory.csv');
      expect(anchor.rel).toBe('noopener');

      await previewPdfFile('JVBERi0x', 'invoice.pdf');
      expect(anchor.target).toBe('_blank');
      expect(anchor.rel).toBe('noopener noreferrer');

      await downloadPdfFile('JVBERi0x', 'invoice.pdf');
      expect(anchor.download).toBe('invoice.pdf');
      expect(click).toHaveBeenCalledTimes(3);
      expect(remove).toHaveBeenCalledTimes(3);
      expect(revokeObjectURL).toHaveBeenCalledTimes(3);
      expect(createObjectURL.mock.calls[1][0]).toBeInstanceOf(Blob);
    } finally {
      (global as any).document = originalDocument;
      (global as any).window = originalWindow;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });

  it('downloads a remote binary and shares it on native', async () => {
    (files.downloadAsync as jest.Mock).mockResolvedValueOnce({ status: 200, uri: 'cache://vendora-inventory.xlsx' });
    await downloadAndShareRemote('https://api.test/x.xlsx', 'vendora-inventory.xlsx', 'tok');
    expect(files.downloadAsync).toHaveBeenCalledWith(
      'https://api.test/x.xlsx',
      'cache://vendora-inventory.xlsx',
      { headers: { Authorization: 'Bearer tok' } },
    );
    expect(sharing.shareAsync).toHaveBeenCalledWith('cache://vendora-inventory.xlsx', expect.objectContaining({ dialogTitle: 'vendora-inventory.xlsx' }));
  });

  it('maps Pro-gated (403) and generic errors, and missing storage/sharing', async () => {
    (files.downloadAsync as jest.Mock).mockResolvedValueOnce({ status: 403, uri: 'x' });
    await expect(downloadAndShareRemote('u', 'f.xlsx', null)).rejects.toThrow(/Pro feature/);

    (files.downloadAsync as jest.Mock).mockResolvedValueOnce({ status: 500, uri: 'x' });
    await expect(downloadAndShareRemote('u', 'f.xlsx', 'tok')).rejects.toThrow('Export failed (500).');

    (FileSystem as any).__setDirectories(null, null);
    await expect(downloadAndShareRemote('u', 'f.xlsx', 'tok')).rejects.toThrow('File storage is not available on this device.');

    (FileSystem as any).__setDirectories('cache://', null);
    (files.downloadAsync as jest.Mock).mockResolvedValueOnce({ status: 200, uri: 'cache://f.xlsx' });
    sharing.isAvailableAsync.mockResolvedValue(false);
    await expect(downloadAndShareRemote('u', 'f.xlsx', 'tok')).rejects.toThrow('File sharing is not available on this device.');
  });

  it('downloads a remote binary in the browser (and surfaces HTTP errors)', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    const anchor: Record<string, unknown> = { click: jest.fn(), remove: jest.fn() };
    const originalDocument = (global as any).document;
    const originalWindow = (global as any).window;
    const originalFetch = (global as any).fetch;
    (global as any).document = { createElement: jest.fn(() => anchor), body: { appendChild: jest.fn() } };
    (global as any).window = { setTimeout: (cb: () => void) => { cb(); return 1; } };
    URL.createObjectURL = jest.fn(() => 'blob:x');
    URL.revokeObjectURL = jest.fn();
    try {
      (global as any).fetch = jest.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['xlsx']) }));
      await downloadAndShareRemote('https://api.test/x.xlsx', 'inv.xlsx', 'tok');
      expect(anchor.download).toBe('inv.xlsx');

      (global as any).fetch = jest.fn(async () => ({ ok: false, status: 402, blob: async () => new Blob([]) }));
      await expect(downloadAndShareRemote('u', 'inv.xlsx', 'tok')).rejects.toThrow(/Pro feature/);
    } finally {
      (global as any).document = originalDocument;
      (global as any).window = originalWindow;
      (global as any).fetch = originalFetch;
    }
  });
});
