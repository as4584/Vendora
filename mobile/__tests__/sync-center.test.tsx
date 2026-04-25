jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

jest.mock('../services/api', () => ({
  listSyncRuns: jest.fn(),
  listReconciliationIssues: jest.fn(),
}));

import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import SyncCenterScreen from '../app/(tabs)/settings/sync-center';

describe('SyncCenterScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (apiMock.listSyncRuns as jest.Mock).mockResolvedValue([
      {
        id: 'run-1',
        provider: 'lightspeed',
        status: 'completed',
        started_at: '2026-04-25T12:00:00Z',
        completed_at: '2026-04-25T12:02:00Z',
        items_imported: 20,
        items_updated: 5,
        errors_count: 0,
      },
    ]);
    (apiMock.listReconciliationIssues as jest.Mock).mockResolvedValue([
      {
        id: 'issue-1',
        provider: 'square',
        issue_type: 'missing_item',
        external_id: 'SQ-123',
        detail: { sku: 'J1-001' },
        status: 'open',
        detected_at: '2026-04-25T12:03:00Z',
        resolved_at: null,
      },
    ]);
  });

  it('renders sync runs and surfaced issues', async () => {
    const screen = render(<SyncCenterScreen />);

    await waitFor(() => {
      expect(screen.getByText('Sync Runs')).toBeTruthy();
      expect(screen.getByText('LIGHTSPEED')).toBeTruthy();
      expect(screen.getByText('COMPLETED')).toBeTruthy();
      expect(screen.getByText('SQUARE • missing item')).toBeTruthy();
      expect(screen.getByText('OPEN')).toBeTruthy();
    });
  });
});
