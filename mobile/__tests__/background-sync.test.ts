jest.mock('expo-background-fetch', () => ({
  BackgroundFetchResult: { NoData: 1, NewData: 2, Failed: 3 },
  BackgroundFetchStatus: { Restricted: 1, Denied: 2, Available: 3 },
  getStatusAsync: jest.fn(),
  registerTaskAsync: jest.fn(),
  unregisterTaskAsync: jest.fn(),
}));

jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn(),
}));

jest.mock('../services/api', () => ({
  getLightspeedStatus: jest.fn(),
  triggerLightspeedSync: jest.fn(),
}));

import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import * as api from '../services/api';
import {
  BACKGROUND_SYNC_TASK,
  registerBackgroundSync,
  unregisterBackgroundSync,
} from '../tasks/backgroundSync';

const background = BackgroundFetch as jest.Mocked<typeof BackgroundFetch>;
const tasks = TaskManager as jest.Mocked<typeof TaskManager>;
const mockedApi = api as jest.Mocked<typeof api>;

function taskCallback(): () => Promise<number> {
  return (tasks.defineTask as jest.Mock).mock.calls[0][1];
}

describe('background sync', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    background.getStatusAsync.mockResolvedValue(
      BackgroundFetch.BackgroundFetchStatus.Available,
    );
    tasks.isTaskRegisteredAsync.mockResolvedValue(false);
    background.registerTaskAsync.mockResolvedValue(undefined);
    background.unregisterTaskAsync.mockResolvedValue(undefined);
    mockedApi.getLightspeedStatus.mockResolvedValue({
      connected: true,
      account_id: 'account-1',
      expires_at: null,
      last_synced_at: null,
    });
    mockedApi.triggerLightspeedSync.mockResolvedValue({
      status: 'completed',
      run_id: 'run-1',
      items_imported: 0,
      items_updated: 0,
      items_skipped: 0,
      transactions_imported: 0,
      transactions_updated: 0,
      errors_count: 0,
    });
    // clearAllMocks removes the initial module-scope call; register the same
    // callback again so each task behavior test is independent.
    jest.isolateModules(() => require('../tasks/backgroundSync'));
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('defines the task with the stable task name', () => {
    expect(tasks.defineTask).toHaveBeenCalledWith(BACKGROUND_SYNC_TASK, expect.any(Function));
  });

  it('returns NoData when Lightspeed is disconnected', async () => {
    mockedApi.getLightspeedStatus.mockResolvedValueOnce({
      connected: false,
      account_id: null,
      expires_at: null,
      last_synced_at: null,
    });
    await expect(taskCallback()()).resolves.toBe(BackgroundFetch.BackgroundFetchResult.NoData);
    expect(mockedApi.triggerLightspeedSync).not.toHaveBeenCalled();
  });

  it('returns NewData when any inventory or transaction counter changed', async () => {
    mockedApi.triggerLightspeedSync.mockResolvedValueOnce({
      status: 'completed',
      run_id: 'run-1',
      items_imported: 0,
      items_updated: 0,
      items_skipped: 0,
      transactions_imported: 1,
      transactions_updated: 0,
      errors_count: 0,
    });
    await expect(taskCallback()()).resolves.toBe(BackgroundFetch.BackgroundFetchResult.NewData);
  });

  it('returns NoData after a successful sync with no changes', async () => {
    await expect(taskCallback()()).resolves.toBe(BackgroundFetch.BackgroundFetchResult.NoData);
  });

  it('returns Failed when status or sync requests fail', async () => {
    mockedApi.getLightspeedStatus.mockRejectedValueOnce(new Error('offline'));
    await expect(taskCallback()()).resolves.toBe(BackgroundFetch.BackgroundFetchResult.Failed);
  });

  it.each([
    BackgroundFetch.BackgroundFetchStatus.Restricted,
    BackgroundFetch.BackgroundFetchStatus.Denied,
  ])('does not register when background fetch status is %s', async (status) => {
    background.getStatusAsync.mockResolvedValueOnce(status);
    await registerBackgroundSync();
    expect(background.registerTaskAsync).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('registers an unregistered task with production-safe scheduling settings', async () => {
    await registerBackgroundSync();
    expect(background.registerTaskAsync).toHaveBeenCalledWith(BACKGROUND_SYNC_TASK, {
      minimumInterval: 900,
      stopOnTerminate: false,
      startOnBoot: true,
    });
    expect(logSpy).toHaveBeenCalledWith('[BackgroundSync] Task registered.');
  });

  it('does not register a second copy of an existing task', async () => {
    tasks.isTaskRegisteredAsync.mockResolvedValueOnce(true);
    await registerBackgroundSync();
    expect(background.registerTaskAsync).not.toHaveBeenCalled();
  });

  it('silently tolerates native registration failures', async () => {
    background.getStatusAsync.mockRejectedValueOnce(new Error('Expo Go'));
    await expect(registerBackgroundSync()).resolves.toBeUndefined();
  });

  it('unregisters an existing task and leaves an absent task alone', async () => {
    tasks.isTaskRegisteredAsync.mockResolvedValueOnce(true);
    await unregisterBackgroundSync();
    expect(background.unregisterTaskAsync).toHaveBeenCalledWith(BACKGROUND_SYNC_TASK);
    expect(logSpy).toHaveBeenCalledWith('[BackgroundSync] Task unregistered.');

    jest.clearAllMocks();
    tasks.isTaskRegisteredAsync.mockResolvedValueOnce(false);
    await unregisterBackgroundSync();
    expect(background.unregisterTaskAsync).not.toHaveBeenCalled();
  });

  it('silently tolerates native unregistration and task-definition failures', async () => {
    tasks.isTaskRegisteredAsync.mockRejectedValueOnce(new Error('Expo Go'));
    await expect(unregisterBackgroundSync()).resolves.toBeUndefined();

    (tasks.defineTask as jest.Mock).mockImplementationOnce(() => {
      throw new Error('native module unavailable');
    });
    expect(() => jest.isolateModules(() => require('../tasks/backgroundSync'))).not.toThrow();
  });
});
