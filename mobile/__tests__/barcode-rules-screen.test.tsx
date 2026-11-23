import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import BarcodeRulesScreen from '../app/(tabs)/settings/barcode-rules';

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({ useLocalSearchParams: () => mockParams }));

jest.mock('../services/api', () => ({
  listBarcodeRules: jest.fn(),
  createBarcodeRule: jest.fn(),
  updateBarcodeRule: jest.fn(),
  deleteBarcodeRule: jest.fn(),
  reorderBarcodeRules: jest.fn(),
  resolveBarcode: jest.fn(),
}));

const RULE = (id: string, name: string, extra = {}) => ({
  id, name, prefix: 'STR-', suffix: null, min_length: null, max_length: null, strip_prefix: true,
  strip_suffix: true, slice_start: null, slice_length: null, lookup_field: 'sku', enabled: true, position: 0, ...extra,
});

const STRIP_SUFFIX = "Remove the 'ends with' part";

describe('BarcodeRulesScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = {};
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    (apiMock.listBarcodeRules as jest.Mock).mockResolvedValue([]);
  });
  afterEach(() => jest.restoreAllMocks());

  it('creates a rule with a live preview against a test code', async () => {
    const screen = render(<BarcodeRulesScreen />);
    await screen.findByText(/No rules yet/);
    fireEvent.changeText(screen.getByTestId('rule-test-input'), 'str-00123');
    fireEvent.press(screen.getByText('Add a rule'));

    fireEvent.press(screen.getByText('Save rule'));
    expect(Alert.alert).toHaveBeenCalledWith('Name the rule', expect.any(String));
    fireEvent.changeText(screen.getByTestId('rule-name'), 'Shelf tags');
    fireEvent.press(screen.getByText('Save rule'));
    expect(Alert.alert).toHaveBeenCalledWith('Which codes?', expect.any(String));

    expect(screen.getByTestId('rule-preview').props.children).toBe("This rule doesn't apply to the test code.");
    fireEvent.changeText(screen.getByTestId('rule-prefix'), 'STR-');
    expect(screen.getByTestId('rule-preview').props.children).toBe('STR-00123 → 00123');
    fireEvent.changeText(screen.getByLabelText('How many characters'), '3x4');
    expect(screen.getByLabelText('How many characters').props.value).toBe('34');
    fireEvent.press(screen.getByText('SKU'));
    fireEvent(screen.getByLabelText(STRIP_SUFFIX), 'valueChange', false);

    (apiMock.createBarcodeRule as jest.Mock).mockResolvedValue(RULE('r1', 'Shelf tags'));
    (apiMock.listBarcodeRules as jest.Mock).mockResolvedValue([RULE('r1', 'Shelf tags', { slice_length: 34 })]);
    await act(async () => fireEvent.press(screen.getByText('Save rule')));
    expect(apiMock.createBarcodeRule).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Shelf tags', prefix: 'STR-', slice_length: 34, lookup_field: 'sku', strip_suffix: false,
    }));
    expect(await screen.findByText('Shelf tags')).toBeTruthy();
    expect(screen.getByText(/starts with STR- \(removed\).*look up as SKU/)).toBeTruthy();
  });

  it('prefills from an unknown scan and tests a code against the server', async () => {
    mockParams = { sample: 'TAG-778' };
    (apiMock.resolveBarcode as jest.Mock)
      .mockResolvedValueOnce({ code: '778', matched_by: 'sku', rule_name: 'Tags', item: { name: 'Dunk' } })
      .mockResolvedValueOnce({ code: 'TAG-778', matched_by: 'linked', rule_name: null, item: { name: 'Dunk' } })
      .mockResolvedValueOnce({ code: 'TAG-778', matched_by: 'upc', rule_name: null, item: { name: 'Dunk' } })
      .mockResolvedValueOnce({ code: 'TAG-778', matched_by: null, rule_name: null, item: null })
      .mockRejectedValueOnce(new Error('offline'));
    const screen = render(<BarcodeRulesScreen />);
    expect(screen.getByTestId('rule-name').props.value).toBe('Codes starting TAG-');
    expect(screen.getByTestId('rule-prefix').props.value).toBe('TAG-');
    for (const expected of [
      '✓ Dunk — found by rule "Tags" (looked up 778)',
      '✓ Dunk — found by a linked barcode (looked up TAG-778)',
      '✓ Dunk — found by upc (looked up TAG-778)',
      'No item for TAG-778. Add a rule or link it from Quick Sale.',
      'offline',
    ]) {
      await act(async () => fireEvent.press(screen.getByText('Check')));
      expect(screen.getByTestId('rule-test-result').props.children).toBe(expected);
    }
    fireEvent.changeText(screen.getByTestId('rule-suffix'), '/b');
    fireEvent(screen.getByLabelText("Remove the 'starts with' part"), 'valueChange', false);
    fireEvent.press(screen.getByText('Cancel'));
    expect(screen.getByText('Add a rule')).toBeTruthy();
  });

  it('suggests a length rule for an all-digit sample and handles load errors', async () => {
    mockParams = { sample: '0012345' };
    (apiMock.listBarcodeRules as jest.Mock).mockRejectedValueOnce(new Error('down'));
    const screen = render(<BarcodeRulesScreen />);
    expect(screen.getByLabelText('Shortest length').props.value).toBe('7');
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith("Couldn't load rules", 'down'));
    fireEvent.changeText(screen.getByTestId('rule-test-input'), '');
    await act(async () => fireEvent.press(screen.getByText('Check')));
    expect(apiMock.resolveBarcode).not.toHaveBeenCalled();
  });

  it('edits, toggles, reorders and deletes rules', async () => {
    const a = RULE('a', 'Alpha', { prefix: null, min_length: 6, max_length: 6 });
    const b = RULE('b', 'Bravo', { prefix: null, suffix: '/Z', strip_suffix: false, min_length: 2, max_length: 9, slice_start: 2 });
    (apiMock.listBarcodeRules as jest.Mock).mockResolvedValue([a, b]);
    const screen = render(<BarcodeRulesScreen />);
    await screen.findByText('Alpha');
    expect(screen.getByText(/6 characters → look up as SKU/)).toBeTruthy();
    expect(screen.getByText(/ends with \/Z, at least 2 characters, at most 9 characters, keep the rest of the characters from #2/)).toBeTruthy();

    (apiMock.updateBarcodeRule as jest.Mock).mockResolvedValueOnce(a);
    await act(async () => fireEvent(screen.getByLabelText('Use Alpha'), 'valueChange', false));
    expect(apiMock.updateBarcodeRule).toHaveBeenCalledWith('a', expect.objectContaining({ enabled: false }));
    (apiMock.updateBarcodeRule as jest.Mock).mockRejectedValueOnce(new Error('nope'));
    await act(async () => fireEvent(screen.getByLabelText('Use Bravo'), 'valueChange', false));
    expect(Alert.alert).toHaveBeenCalledWith("Couldn't update rule", 'nope');

    (apiMock.reorderBarcodeRules as jest.Mock).mockResolvedValueOnce([b, a]);
    await act(async () => fireEvent.press(screen.getAllByLabelText('Move down')[0]));
    expect(apiMock.reorderBarcodeRules).toHaveBeenCalledWith(['b', 'a']);
    (apiMock.reorderBarcodeRules as jest.Mock).mockRejectedValueOnce(new Error('order'));
    await act(async () => fireEvent.press(screen.getAllByLabelText('Move up')[1]));
    expect(Alert.alert).toHaveBeenCalledWith("Couldn't reorder", 'order');

    fireEvent.press(screen.getByText('Alpha'));
    expect(screen.getByText('Edit rule')).toBeTruthy();
    expect(screen.getByLabelText('Longest length').props.value).toBe('6');
    (apiMock.updateBarcodeRule as jest.Mock).mockRejectedValueOnce(new Error('save failed'));
    await act(async () => fireEvent.press(screen.getByText('Save rule')));
    expect(Alert.alert).toHaveBeenCalledWith("Couldn't save rule", 'save failed');
    (apiMock.updateBarcodeRule as jest.Mock).mockResolvedValueOnce(a);
    await act(async () => fireEvent.press(screen.getByText('Save rule')));
    expect(apiMock.updateBarcodeRule).toHaveBeenLastCalledWith('a', expect.objectContaining({ name: 'Alpha', min_length: 6 }));

    fireEvent.press(screen.getByLabelText('Delete Alpha'));
    const buttons = (Alert.alert as jest.Mock).mock.calls.at(-1)[2];
    (apiMock.deleteBarcodeRule as jest.Mock).mockResolvedValueOnce(undefined);
    await act(async () => buttons[1].onPress());
    expect(apiMock.deleteBarcodeRule).toHaveBeenCalledWith('a');
    fireEvent.press(screen.getByLabelText('Delete Bravo'));
    (apiMock.deleteBarcodeRule as jest.Mock).mockRejectedValueOnce(new Error('locked'));
    await act(async () => (Alert.alert as jest.Mock).mock.calls.at(-1)[2][1].onPress());
    expect(Alert.alert).toHaveBeenCalledWith("Couldn't delete rule", 'locked');
  });
});
