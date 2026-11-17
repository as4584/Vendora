import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { UndoBar, UNDO_MS, useUndo, type UndoState } from '../components/UndoBar';

jest.mock('../components/Backdrop', () => ({ GlassBlur: () => null }));

let state: UndoState;
function Harness({ log }: { log: string[] }) {
  state = useUndo();
  return (
    <>
      <Text>{log.join(',')}</Text>
      <UndoBar state={state} />
    </>
  );
}

const action = (log: string[], name: string, commit = jest.fn(async () => { log.push(`commit:${name}`); })) => ({
  message: `Deleted ${name}`,
  apply: () => log.push(`apply:${name}`),
  revert: () => log.push(`revert:${name}`),
  commit,
});

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('applies now and commits only after the bar times out', async () => {
  const log: string[] = [];
  const s = render(<Harness log={log} />);
  act(() => state.run(action(log, 'a')));
  expect(log).toEqual(['apply:a']);
  expect(s.getByText('Deleted a')).toBeTruthy();
  await act(async () => { jest.advanceTimersByTime(UNDO_MS); });
  expect(log).toEqual(['apply:a', 'commit:a']);
  expect(s.queryByTestId('undo-bar')).toBeNull();
});

it('undo reverts with no server call', async () => {
  const log: string[] = [];
  const s = render(<Harness log={log} />);
  const commit = jest.fn(async () => undefined);
  act(() => state.run(action(log, 'a', commit)));
  fireEvent.press(s.getByTestId('undo-button'));
  await act(async () => { jest.advanceTimersByTime(UNDO_MS * 2); });
  expect(log).toEqual(['apply:a', 'revert:a']);
  expect(commit).not.toHaveBeenCalled();
});

it('a second action commits the first one immediately', async () => {
  const log: string[] = [];
  render(<Harness log={log} />);
  act(() => state.run(action(log, 'a')));
  await act(async () => state.run(action(log, 'b')));
  expect(log).toEqual(['apply:a', 'commit:a', 'apply:b']);
});

it('puts things back and reports when the server refuses', async () => {
  const log: string[] = [];
  render(<Harness log={log} />);
  const onCommitError = jest.fn();
  act(() => state.run({ ...action(log, 'a', jest.fn(async () => { throw new Error('nope'); })), onCommitError }));
  await act(async () => { jest.advanceTimersByTime(UNDO_MS); });
  expect(log).toEqual(['apply:a', 'revert:a']);
  expect(onCommitError).toHaveBeenCalled();
});

it('leaving the screen commits what is pending', async () => {
  const log: string[] = [];
  const s = render(<Harness log={log} />);
  act(() => state.run(action(log, 'a')));
  await act(async () => s.unmount());
  expect(log).toEqual(['apply:a', 'commit:a']);
});
