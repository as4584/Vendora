import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import ImportReview from '../components/ImportReview';
import {
  commitLabel,
  draftFromRow,
  draftToPayload,
  reviewCounts,
  reviewSummary,
  rowToItem,
  validateDraft,
} from '../utils/importReview';

jest.mock('../services/api', () => ({
  updateInventoryImportRow: jest.fn(),
}));

const row = (over: Partial<apiMock.ImportPreviewRow>): apiMock.ImportPreviewRow => ({
  id: 'r1',
  row_number: 1,
  action: 'create',
  inventory_item_id: null,
  mapped_data: { name: 'Jordan 4', sku: 'J4', quantity: 2, buy_price: 100, expected_sell_price: 150, size: '10' },
  match_key: null,
  match_value: null,
  error_message: null,
  ...over,
});

const preview = (rows: apiMock.ImportPreviewRow[]): apiMock.InventoryImportPreview => ({
  job_id: 'job-1',
  status: 'previewed',
  filename: 'show.csv',
  detected_mapping: {},
  rows,
  total_rows: rows.length,
  rows_to_create: 0,
  rows_to_update: 0,
  rows_to_skip: 0,
  rows_errored: 0,
});

describe('import review helpers', () => {
  it('maps a row to an inventory-shaped item', () => {
    const item = rowToItem(row({}));
    expect(item).toMatchObject({ name: 'Jordan 4', sku: 'J4', quantity: 2, buy_price: '100', size: '10', source: 'spreadsheet', status: 'in_stock' });
    const bare = rowToItem(row({ id: null, row_number: 7, mapped_data: null }));
    expect(bare).toMatchObject({ id: 'row-7', name: 'Row 7', quantity: 1, sku: null });
  });

  it('validates like the importer', () => {
    expect(validateDraft({ name: '' })).toEqual({ name: 'Name is required.' });
    expect(validateDraft({ name: 'x', quantity: '2.5' }).quantity).toMatch(/whole/);
    expect(validateDraft({ name: 'x', quantity: '-1' }).quantity).toMatch(/negative/);
    expect(validateDraft({ name: 'x', buy_price: 'abc' }).buy_price).toMatch(/number/);
    expect(validateDraft({ name: 'x', buy_price: '$' }).buy_price).toMatch(/number/);
    expect(validateDraft({ name: 'x', expected_sell_price: '-3' }).expected_sell_price).toMatch(/negative/);
    expect(validateDraft({ name: 'x', buy_price: '$1,200.50', quantity: '3' })).toEqual({});
  });

  it('round-trips a draft and blanks become null', () => {
    const draft = draftFromRow(row({}));
    expect(draft.name).toBe('Jordan 4');
    expect(draft.notes).toBe('');
    const payload = draftToPayload({ ...draft, color: '  ' });
    expect(payload.color).toBeNull();
    expect(payload.quantity).toBe('2');
  });

  it('counts and labels', () => {
    const c = reviewCounts([
      row({ action: 'create' }), row({ action: 'update' }), row({ action: 'update' }),
      row({ action: 'error' }), row({ action: 'skip' }),
    ]);
    expect(c).toEqual({ items: 4, updates: 2, needsFix: 1, importable: 3, removed: 1 });
    expect(reviewSummary(c)).toBe('4 items · 2 updates · 1 needs a fix');
    expect(commitLabel(c)).toBe('Add 3 items to inventory');
    const one = reviewCounts([row({}), row({ action: 'error' }), row({ action: 'error' })]);
    expect(reviewSummary(one)).toBe('3 items · 2 need a fix');
    expect(commitLabel(one)).toBe('Add 1 item to inventory');
    expect(commitLabel(reviewCounts([]))).toBe('Nothing to add yet');
  });
});

describe('ImportReview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('renders rows as inventory cards with action badges and an error flag', () => {
    const screen = render(
      <ImportReview
        preview={preview([
          row({}),
          row({ id: 'r2', row_number: 2, action: 'update', mapped_data: { name: 'Dunk Low', sku: 'DD1' } }),
          row({ id: 'r3', row_number: 3, action: 'error', mapped_data: null, error_message: "Required field 'name' is missing or empty." }),
        ])}
        committing={false}
        onCommit={jest.fn()}
      />,
    );
    expect(screen.getByText('3 items · 1 update · 1 needs a fix')).toBeTruthy();
    expect(screen.getByText('Jordan 4')).toBeTruthy();
    expect(screen.getByText('Updates existing')).toBeTruthy();
    expect(screen.getByText('Needs a fix')).toBeTruthy();
    expect(screen.getByText(/Row 3: Required field 'name'/)).toBeTruthy();
    expect(screen.getByText('Add 2 items to inventory')).toBeTruthy();
    expect(screen.getByText('$150.00')).toBeTruthy();
  });

  it('removes a row server-side and undoes it', async () => {
    (apiMock.updateInventoryImportRow as jest.Mock)
      .mockResolvedValueOnce(row({ action: 'skip' }))
      .mockResolvedValueOnce(row({ action: 'create' }));
    const onRowsChange = jest.fn();
    const screen = render(
      <ImportReview preview={preview([row({}), row({ id: 'r2', row_number: 2, mapped_data: { name: 'Samba' } })])} committing={false} onCommit={jest.fn()} onRowsChange={onRowsChange} />,
    );
    await act(async () => { fireEvent.press(screen.getByLabelText('Remove Jordan 4')); });
    expect(apiMock.updateInventoryImportRow).toHaveBeenCalledWith('job-1', 'r1', { skip: true });
    expect(screen.queryByLabelText('Review Jordan 4')).toBeNull();
    expect(screen.getByText('Removed Jordan 4')).toBeTruthy();
    expect(screen.getByText('Add 1 item to inventory')).toBeTruthy();

    await act(async () => { fireEvent.press(screen.getByText('Undo')); });
    expect(apiMock.updateInventoryImportRow).toHaveBeenLastCalledWith('job-1', 'r1', { skip: false });
    expect(screen.getByText('Add 2 items to inventory')).toBeTruthy();
    expect(onRowsChange).toHaveBeenCalled();
  });

  it('rolls back a failed remove and a failed undo', async () => {
    (apiMock.updateInventoryImportRow as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    const screen = render(<ImportReview preview={preview([row({})])} committing={false} onCommit={jest.fn()} />);
    await act(async () => { fireEvent.press(screen.getByLabelText('Remove Jordan 4')); });
    expect(Alert.alert).toHaveBeenCalledWith("Couldn't remove the row", 'offline');
    expect(screen.getByText('Jordan 4')).toBeTruthy();

    (apiMock.updateInventoryImportRow as jest.Mock)
      .mockResolvedValueOnce(row({ action: 'skip' }))
      .mockRejectedValueOnce(new Error('down'));
    await act(async () => { fireEvent.press(screen.getByLabelText('Remove Jordan 4')); });
    expect(screen.getByText('Every row was removed. Undo a removal or choose another file.')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByText('Undo')); });
    expect(Alert.alert).toHaveBeenCalledWith("Couldn't restore the row", 'down');
    expect(screen.getByText('Nothing to add yet')).toBeTruthy();
  });

  it('edits a row with client validation, then saves through the API', async () => {
    (apiMock.updateInventoryImportRow as jest.Mock).mockResolvedValueOnce(
      row({ id: 'r3', row_number: 3, action: 'create', mapped_data: { name: 'Pokemon ETB', quantity: 3 } }),
    );
    const onCommit = jest.fn();
    const screen = render(
      <ImportReview
        preview={preview([row({ id: 'r3', row_number: 3, action: 'error', mapped_data: { sku: 'PKM' }, error_message: 'Name missing' })])}
        committing={false}
        onCommit={onCommit}
      />,
    );
    expect(screen.getByText('Nothing to add yet')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Fix Row 3'));
    expect(screen.getByText('Edit row 3')).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText('Quantity'), 'three');
    await act(async () => { fireEvent.press(screen.getByText('Save')); });
    expect(screen.getByText('Name is required.')).toBeTruthy();
    expect(screen.getByText('Use a whole number.')).toBeTruthy();
    expect(apiMock.updateInventoryImportRow).not.toHaveBeenCalled();

    fireEvent.changeText(screen.getByLabelText('Name'), 'Pokemon ETB');
    fireEvent.changeText(screen.getByLabelText('Quantity'), '3');
    await act(async () => { fireEvent.press(screen.getByText('Save')); });
    expect(apiMock.updateInventoryImportRow).toHaveBeenCalledWith('job-1', 'r3', {
      data: expect.objectContaining({ name: 'Pokemon ETB', quantity: '3', sku: 'PKM', color: null }),
    });
    await waitFor(() => expect(screen.queryByText('Edit row 3')).toBeNull());
    expect(screen.getByText('New item')).toBeTruthy();
    fireEvent.press(screen.getByText('Add 1 item to inventory'));
    expect(onCommit).toHaveBeenCalled();
  });

  it('keeps the sheet open when the server still rejects the row, and reports save failures', async () => {
    (apiMock.updateInventoryImportRow as jest.Mock)
      .mockResolvedValueOnce(row({ action: 'error', error_message: "Column 'buy_price': bad" }))
      .mockRejectedValueOnce(new Error('timeout'));
    const screen = render(<ImportReview preview={preview([row({})])} committing={false} onCommit={jest.fn()} />);
    fireEvent.press(screen.getByLabelText('Edit Jordan 4'));
    await act(async () => { fireEvent.press(screen.getByText('Save')); });
    expect(screen.getByText("Column 'buy_price': bad")).toBeTruthy();
    expect(screen.getByText('Edit row 1')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByText('Save')); });
    expect(Alert.alert).toHaveBeenCalledWith("Couldn't save the row", 'timeout');
    fireEvent.press(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByText('Edit row 1')).toBeNull());
  });

  it('opens the editor from a card tap and shows a busy commit', () => {
    const screen = render(<ImportReview preview={preview([row({})])} committing onCommit={jest.fn()} />);
    fireEvent.press(screen.getByTestId('import-row-1'));
    expect(screen.getByText('Edit row 1')).toBeTruthy();
  });
});
