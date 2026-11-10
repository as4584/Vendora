import React from 'react';
import { Alert, Platform } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
const mockOpen = jest.fn(async (_url: string) => 'closed');
jest.mock('../utils/oauthConnect', () => ({ openProviderConnect: (url: string) => mockOpen(url) }));
import * as Linking from 'expo-linking';
import * as api from '../services/api';
import {
  EXISTING_SHEET_HELP,
  GoogleSheetsPrompt,
  GoogleSheetsSettingsCard,
  SOURCE_OF_TRUTH_HELP,
  lastSyncLabel,
  syncSummary,
} from '../components/GoogleSheets';

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn(async () => ({ type: 'cancel' })) }));
jest.mock('expo-linking', () => ({ createURL: jest.fn(() => 'vendora://settings'), openURL: jest.fn() }));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(), notificationAsync: jest.fn(), ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
jest.mock('../services/api', () => ({
  getGoogleSheetsStatus: jest.fn(),
  getGoogleConnectUrl: jest.fn(),
  disconnectGoogle: jest.fn(),
  createGoogleSheet: jest.fn(),
  linkGoogleSheet: jest.fn(),
  updateGoogleSheetSettings: jest.fn(),
  unlinkGoogleSheet: jest.fn(),
  syncGoogleSheets: jest.fn(),
}));

const m = api as jest.Mocked<typeof api>;
const SHEET: api.GoogleSheetLink = {
  spreadsheet_id: 'sid', title: 'Resqlo Inventory', url: 'https://docs.google.com/spreadsheets/d/sid/edit', tab: 'Inventory',
  source_of_truth: true, archive_missing: false, last_synced_at: null, last_error: null, mapped_columns: ['id', 'name'],
};
const CONNECTED: api.GoogleSheetsStatus = { configured: true, connected: true, email: 'seller@example.com', sheet: null, pending_pushes: 0, failed_pushes: 0 };
const LINKED: api.GoogleSheetsStatus = { ...CONNECTED, sheet: SHEET, pending_pushes: 2, failed_pushes: 1 };

function pressAlertButton(label: string) {
  const calls = (Alert.alert as jest.Mock).mock.calls;
  const buttons = calls[calls.length - 1][2] as { text: string; onPress?: () => unknown }[];
  return buttons.find((b) => b.text === label)!.onPress!();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  m.getGoogleSheetsStatus.mockResolvedValue(LINKED);
});

describe('helpers', () => {
  it('formats the last sync time', () => {
    const now = Date.parse('2026-11-07T12:00:00Z');
    expect(lastSyncLabel(null, now)).toBe('Not synced yet');
    expect(lastSyncLabel('2026-11-07T11:59:40Z', now)).toBe('Synced just now');
    expect(lastSyncLabel('2026-11-07T11:45:00Z', now)).toBe('Synced 15m ago');
    expect(lastSyncLabel('2026-11-07T09:00:00Z', now)).toBe('Synced 3h ago');
    expect(lastSyncLabel('2026-11-05T12:00:00Z', now)).toBe('Synced 2d ago');
    expect(lastSyncLabel('2026-11-07T11:59:40Z')).toMatch(/^Synced/);
  });

  it('summarises a sync and includes the sheet-wins note', () => {
    const base = { run_id: null, created: 0, updated: 0, archived: 0, appended: 0, conflicts: 0, note: null, pushes_processed: 0 };
    expect(syncSummary(base)).toBe('Everything already matches.');
    expect(syncSummary({ ...base, created: 1, updated: 2, archived: 1, appended: 3, note: 'Sheet won over app edits on Tee: quantity' }))
      .toBe('1 new, 2 updated, 1 archived, 3 added to the sheet\nSheet won over app edits on Tee: quantity');
  });
});

describe('GoogleSheetsSettingsCard', () => {
  it('shows not configured', async () => {
    m.getGoogleSheetsStatus.mockResolvedValue({ ...CONNECTED, configured: false, connected: false });
    render(<GoogleSheetsSettingsCard />);
    expect(await screen.findByText('Not configured')).toBeTruthy();
    expect(screen.queryByText('Connect Google')).toBeNull();
  });

  it('shows an unavailable note when status fails', async () => {
    m.getGoogleSheetsStatus.mockRejectedValue(new Error('down'));
    render(<GoogleSheetsSettingsCard />);
    expect(await screen.findByText('Google Sheets status is unavailable right now.')).toBeTruthy();
  });

  it('connects through the auth browser (native) and reports failures', async () => {
    m.getGoogleSheetsStatus.mockResolvedValue({ ...CONNECTED, connected: false });
    m.getGoogleConnectUrl.mockResolvedValueOnce({ authorization_url: 'https://accounts.google.test/auth' });
    render(<GoogleSheetsSettingsCard />);
    fireEvent.press(await screen.findByText('Connect Google'));
    await waitFor(() => expect(mockOpen).toHaveBeenCalledWith('https://accounts.google.test/auth'));
    expect(m.getGoogleConnectUrl).toHaveBeenCalledWith(Platform.OS === 'web' ? 'web' : 'native');
    m.getGoogleConnectUrl.mockRejectedValueOnce(new Error('Google Sheets not configured'));
    fireEvent.press(screen.getByText('Connect Google'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Google unavailable', 'Google Sheets not configured'));
  });

  it('creates a Resqlo sheet when connected without a sheet', async () => {
    m.getGoogleSheetsStatus.mockResolvedValue(CONNECTED);
    m.createGoogleSheet.mockResolvedValueOnce(LINKED);
    render(<GoogleSheetsSettingsCard />);
    expect(await screen.findByText('Signed in as seller@example.com')).toBeTruthy();
    fireEvent.press(screen.getByText('Create a Resqlo sheet'));
    expect(await screen.findByText('Resqlo Inventory · Inventory')).toBeTruthy();
  });

  it('links a pasted sheet and explains the drive.file limit', async () => {
    m.getGoogleSheetsStatus.mockResolvedValue(CONNECTED);
    m.linkGoogleSheet.mockRejectedValueOnce(new Error("Resqlo can't open that sheet."));
    m.linkGoogleSheet.mockResolvedValueOnce(LINKED);
    render(<GoogleSheetsSettingsCard />);
    fireEvent.press(await screen.findByText('Use an existing sheet'));
    expect(screen.getByText(EXISTING_SHEET_HELP)).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText('Google Sheets link'), ' https://docs.google.com/spreadsheets/d/sid/edit ');
    fireEvent.press(screen.getByText('Use this sheet'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Could not use that sheet', "Resqlo can't open that sheet."));
    fireEvent.press(screen.getByText('Use this sheet'));
    expect(await screen.findByText('Open in Sheets')).toBeTruthy();
    expect(m.linkGoogleSheet).toHaveBeenLastCalledWith('https://docs.google.com/spreadsheets/d/sid/edit');
  });

  it('cancels pasting a link', async () => {
    m.getGoogleSheetsStatus.mockResolvedValue(CONNECTED);
    render(<GoogleSheetsSettingsCard />);
    fireEvent.press(await screen.findByText('Use an existing sheet'));
    fireEvent.press(screen.getByText('Cancel'));
    expect(screen.queryByLabelText('Google Sheets link')).toBeNull();
  });

  it('shows the linked sheet, opens it, and has no sync button', async () => {
    render(<GoogleSheetsSettingsCard />);
    expect(await screen.findByText('Resqlo Inventory · Inventory')).toBeTruthy();
    expect(screen.getByText(/2 change\(s\) waiting/)).toBeTruthy();
    expect(screen.getByText(/1 failed, see Sync Center/)).toBeTruthy();
    expect(screen.getByText(SOURCE_OF_TRUTH_HELP)).toBeTruthy();
    fireEvent.press(screen.getByText('Open in Sheets'));
    expect(Linking.openURL).toHaveBeenCalledWith(SHEET.url);
    expect(screen.queryByText('Sync now')).toBeNull();
  });

  it('shows the last sync problem', async () => {
    m.getGoogleSheetsStatus.mockResolvedValue({ ...LINKED, sheet: { ...SHEET, last_error: 'HTTP 429', url: null } });
    render(<GoogleSheetsSettingsCard />);
    expect(await screen.findByText('Last sync problem: HTTP 429')).toBeTruthy();
    expect(screen.queryByText('Open in Sheets')).toBeNull();
  });

  it('toggles source of truth and archive behaviour', async () => {
    m.updateGoogleSheetSettings.mockResolvedValue({ ...LINKED, sheet: { ...SHEET, source_of_truth: false } });
    render(<GoogleSheetsSettingsCard />);
    fireEvent(await screen.findByLabelText('Sheet is the source of truth'), 'valueChange', false);
    await waitFor(() => expect(m.updateGoogleSheetSettings).toHaveBeenCalledWith({ source_of_truth: false }));
    fireEvent(screen.getByLabelText('Archive items deleted from the sheet'), 'valueChange', true);
    await waitFor(() => expect(m.updateGoogleSheetSettings).toHaveBeenCalledWith({ archive_missing: true }));
  });

  it('unlinks and disconnects after confirmation', async () => {
    m.unlinkGoogleSheet.mockResolvedValue(CONNECTED);
    m.disconnectGoogle.mockResolvedValue({ disconnected: true });
    render(<GoogleSheetsSettingsCard />);
    fireEvent.press(await screen.findByText('Unlink sheet'));
    await act(async () => { await pressAlertButton('Unlink'); });
    expect(m.unlinkGoogleSheet).toHaveBeenCalled();
    fireEvent.press(screen.getByText('Disconnect'));
    await act(async () => { await pressAlertButton('Disconnect'); });
    expect(m.disconnectGoogle).toHaveBeenCalled();
  });

  it('disconnects from the connected state', async () => {
    m.getGoogleSheetsStatus.mockResolvedValue(CONNECTED);
    m.disconnectGoogle.mockRejectedValueOnce(new Error('nope'));
    render(<GoogleSheetsSettingsCard />);
    fireEvent.press(await screen.findByText('Disconnect Google'));
    await act(async () => { await pressAlertButton('Disconnect'); });
    expect(Alert.alert).toHaveBeenLastCalledWith('Disconnect failed', 'nope');
  });

  it('tells the seller when Google sign-in was denied', async () => {
    m.getGoogleSheetsStatus.mockResolvedValue({ ...CONNECTED, connected: false });
    m.getGoogleConnectUrl.mockResolvedValueOnce({ authorization_url: 'https://accounts.google.test/auth' });
    mockOpen.mockResolvedValueOnce('denied');
    render(<GoogleSheetsSettingsCard />);
    fireEvent.press(await screen.findByText('Connect Google'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Google not connected', 'Google sign-in was cancelled or denied.'));
  });

  it('shows the linked state after connecting', async () => {
    m.getGoogleSheetsStatus.mockResolvedValueOnce({ ...CONNECTED, connected: false }).mockResolvedValue(CONNECTED);
    m.getGoogleConnectUrl.mockResolvedValueOnce({ authorization_url: 'https://accounts.google.test/auth' });
    mockOpen.mockResolvedValueOnce('connected');
    render(<GoogleSheetsSettingsCard />);
    fireEvent.press(await screen.findByText('Connect Google'));
    expect(await screen.findByText('Create a Resqlo sheet')).toBeTruthy();
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('reports failures for create, toggle and unlink', async () => {
    m.getGoogleSheetsStatus.mockResolvedValue(CONNECTED);
    m.createGoogleSheet.mockRejectedValueOnce(new Error('quota'));
    render(<GoogleSheetsSettingsCard />);
    fireEvent.press(await screen.findByText('Create a Resqlo sheet'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Could not create the sheet', 'quota'));
  });

  it('reports a failed settings save and a failed unlink', async () => {
    m.updateGoogleSheetSettings.mockRejectedValueOnce(new Error('offline'));
    m.unlinkGoogleSheet.mockRejectedValueOnce(new Error('gone'));
    render(<GoogleSheetsSettingsCard />);
    fireEvent(await screen.findByLabelText('Sheet is the source of truth'), 'valueChange', false);
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Could not save', 'offline'));
    fireEvent.press(screen.getByText('Unlink sheet'));
    await act(async () => { await pressAlertButton('Unlink'); });
    expect(Alert.alert).toHaveBeenLastCalledWith('Unlink failed', 'gone');
  });
});

describe('GoogleSheetsPrompt', () => {
  it('sends the seller to Settings', () => {
    const onPress = jest.fn();
    render(<GoogleSheetsPrompt onPress={onPress} />);
    expect(screen.getByText('Already track stock in a spreadsheet?')).toBeTruthy();
    fireEvent.press(screen.getByText('Connect Google Sheets'));
    expect(onPress).toHaveBeenCalled();
  });

  it('falls back to the app settings link', () => {
    render(<GoogleSheetsPrompt />);
    fireEvent.press(screen.getByText('Connect Google Sheets'));
    expect(Linking.openURL).toHaveBeenCalledWith('vendora://settings');
  });

  it('accepts custom copy for the Import screen', () => {
    render(<GoogleSheetsPrompt title="Keep a Google Sheet in sync instead" cta="Set up Google Sheets sync" />);
    expect(screen.getByText('Set up Google Sheets sync')).toBeTruthy();
  });
});
