import { failedSyncLabel, syncSummary, timeAgo } from '../utils/syncStatus';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

describe('timeAgo', () => {
  it('formats seconds, minutes, hours and days', () => {
    expect(timeAgo(null, NOW)).toBe('');
    expect(timeAgo(ago(10), NOW)).toBe('just now');
    expect(timeAgo(ago(120), NOW)).toBe('2m ago');
    expect(timeAgo(ago(3 * 3600), NOW)).toBe('3h ago');
    expect(timeAgo(ago(2 * 86400), NOW)).toBe('2d ago');
  });
});

describe('syncSummary', () => {
  const base = { online: true, pending: 0, failed: 0, lastSync: null };
  it('confirms everything synced, with the time', () => {
    expect(syncSummary(base, NOW)).toEqual({ tone: 'success', label: 'All synced' });
    expect(syncSummary({ ...base, lastSync: ago(300) }, NOW).label).toBe('All synced · 5m ago');
  });
  it('shows syncing and offline backlogs', () => {
    expect(syncSummary({ ...base, pending: 1 }, NOW)).toEqual({ tone: 'info', label: 'Syncing 1 change…' });
    expect(syncSummary({ ...base, online: false, pending: 3 }, NOW).label).toBe('Offline · 3 changes saved on this phone');
    expect(syncSummary({ ...base, online: false }, NOW).tone).toBe('warning');
  });
  it('puts rejected changes first', () => {
    expect(syncSummary({ ...base, online: false, pending: 2, failed: 2 }, NOW)).toEqual({
      tone: 'danger', label: "2 changes didn't sync · Review",
    });
  });
});

it('labels failed change kinds', () => {
  expect(failedSyncLabel('quick_sale')).toBe('Sale');
  expect(failedSyncLabel('create_item')).toBe('New item');
});
