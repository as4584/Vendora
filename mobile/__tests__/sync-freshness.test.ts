import { syncFreshness } from '../utils/inventory';

const now = new Date('2026-11-10T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

it('describes how fresh an automatic sync is', () => {
  expect(syncFreshness(null, now)).toBe('Syncing automatically');
  expect(syncFreshness('garbage', now)).toBe('Syncing automatically');
  expect(syncFreshness(ago(20_000), now)).toBe('Updated just now');
  expect(syncFreshness(ago(5 * 60_000), now)).toBe('Updated 5 min ago');
  expect(syncFreshness(ago(3 * 3_600_000), now)).toBe('Updated 3 hr ago');
  expect(syncFreshness(ago(26 * 3_600_000), now)).toBe('Updated 1 day ago');
  expect(syncFreshness(ago(72 * 3_600_000), now)).toBe('Updated 3 days ago');
});
