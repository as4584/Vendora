import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Card, SectionLabel } from "../../../components/ui";
import { Button, IconButton, triggerHaptic } from "../../../components/Button";
import * as api from "../../../services/api";
import { errorMessage } from "../../../services/errors";
import { COLORS, RADII, SPACING, TYPE } from "../../../theme/tokens";
import { applyRule, LOOKUP_LABELS, suggestRule, type LookupField } from "../../../utils/barcodeRules";

type Draft = {
  id?: string;
  name: string;
  prefix: string;
  suffix: string;
  minLength: string;
  maxLength: string;
  stripPrefix: boolean;
  stripSuffix: boolean;
  sliceStart: string;
  sliceLength: string;
  lookup: LookupField;
  enabled: boolean;
};

const EMPTY: Draft = {
  name: "", prefix: "", suffix: "", minLength: "", maxLength: "",
  stripPrefix: true, stripSuffix: true, sliceStart: "", sliceLength: "", lookup: "auto", enabled: true,
};

const num = (v: string) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function draftToInput(d: Draft): api.BarcodeRuleInput {
  return {
    name: d.name.trim(),
    prefix: d.prefix.trim() || null,
    suffix: d.suffix.trim() || null,
    min_length: num(d.minLength),
    max_length: num(d.maxLength),
    strip_prefix: d.stripPrefix,
    strip_suffix: d.stripSuffix,
    slice_start: num(d.sliceStart),
    slice_length: num(d.sliceLength),
    lookup_field: d.lookup,
    enabled: d.enabled,
  };
}

function ruleToDraft(r: api.BarcodeRule): Draft {
  const s = (v: number | null) => (v ? String(v) : "");
  return {
    id: r.id, name: r.name, prefix: r.prefix ?? "", suffix: r.suffix ?? "",
    minLength: s(r.min_length), maxLength: s(r.max_length),
    stripPrefix: r.strip_prefix, stripSuffix: r.strip_suffix,
    sliceStart: s(r.slice_start), sliceLength: s(r.slice_length),
    lookup: r.lookup_field, enabled: r.enabled,
  };
}

function describeRule(r: api.BarcodeRuleInput): string {
  const parts: string[] = [];
  if (r.prefix) parts.push(`starts with ${r.prefix}${r.strip_prefix === false ? "" : " (removed)"}`);
  if (r.suffix) parts.push(`ends with ${r.suffix}${r.strip_suffix === false ? "" : " (removed)"}`);
  if (r.min_length && r.min_length === r.max_length) parts.push(`${r.min_length} characters`);
  else {
    if (r.min_length) parts.push(`at least ${r.min_length} characters`);
    if (r.max_length) parts.push(`at most ${r.max_length} characters`);
  }
  if (r.slice_start || r.slice_length) {
    parts.push(`keep ${r.slice_length ?? "the rest of the"} characters from #${r.slice_start ?? 1}`);
  }
  return `${parts.join(", ")} → look up as ${LOOKUP_LABELS[r.lookup_field ?? "auto"]}`;
}

export default function BarcodeRulesScreen() {
  const { sample } = useLocalSearchParams<{ sample?: string }>();
  const [rules, setRules] = useState<api.BarcodeRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [testCode, setTestCode] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRules(await api.listBarcodeRules());
    } catch (err) {
      Alert.alert("Couldn't load rules", errorMessage(err, "Try again."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    api
      .listBarcodeRules()
      .then(setRules)
      .catch((err) => Alert.alert("Couldn't load rules", errorMessage(err, "Try again.")))
      .finally(() => setLoading(false));
  }, []);

  // Opened from an unknown scan: start a rule shaped like that code. The
  // screen stays mounted between visits, so react to each new sample.
  const [seenSample, setSeenSample] = useState<string | undefined>(undefined);
  if (typeof sample === "string" && sample && sample !== seenSample) {
    setSeenSample(sample);
    setTestCode(sample);
    setTestResult(null);
    const s = suggestRule(sample);
    setDraft({
      ...EMPTY,
      name: s.name,
      prefix: s.prefix ?? "",
      minLength: s.min_length ? String(s.min_length) : "",
      maxLength: s.max_length ? String(s.max_length) : "",
    });
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));

  const save = async () => {
    if (!draft) return;
    const input = draftToInput(draft);
    if (!input.name) {
      Alert.alert("Name the rule", "For example: Shelf tags or Consignment stickers.");
      return;
    }
    if (!input.prefix && !input.suffix && !input.min_length && !input.max_length) {
      Alert.alert("Which codes?", "Fill in 'starts with', 'ends with' or a length so the rule knows which scans it covers.");
      return;
    }
    setSaving(true);
    try {
      if (draft.id) await api.updateBarcodeRule(draft.id, input);
      else await api.createBarcodeRule(input);
      triggerHaptic("success");
      setDraft(null);
      await load();
    } catch (err) {
      Alert.alert("Couldn't save rule", errorMessage(err, "Try again."));
    } finally {
      setSaving(false);
    }
  };

  const remove = (rule: api.BarcodeRule) => {
    Alert.alert("Delete rule?", rule.name, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await api.deleteBarcodeRule(rule.id);
            await load();
          } catch (err) {
            Alert.alert("Couldn't delete rule", errorMessage(err, "Try again."));
          }
        },
      },
    ]);
  };

  const toggle = async (rule: api.BarcodeRule, enabled: boolean) => {
    setRules((list) => list.map((r) => (r.id === rule.id ? { ...r, enabled } : r)));
    try {
      await api.updateBarcodeRule(rule.id, { ...rule, enabled });
    } catch (err) {
      setRules((list) => list.map((r) => (r.id === rule.id ? { ...r, enabled: !enabled } : r)));
      Alert.alert("Couldn't update rule", errorMessage(err, "Try again."));
    }
  };

  const move = async (index: number, delta: number) => {
    const next = [...rules];
    const [rule] = next.splice(index, 1);
    next.splice(index + delta, 0, rule);
    setRules(next);
    try {
      setRules(await api.reorderBarcodeRules(next.map((r) => r.id)));
    } catch (err) {
      await load();
      Alert.alert("Couldn't reorder", errorMessage(err, "Try again."));
    }
  };

  const runTest = async () => {
    const code = testCode.trim();
    if (!code) return;
    setTestResult("Checking…");
    try {
      const res = await api.resolveBarcode(code);
      if (res.item) {
        const via = res.rule_name ? `rule "${res.rule_name}"` : res.matched_by === "linked" ? "a linked barcode" : res.matched_by;
        setTestResult(`✓ ${res.item.name} — found by ${via} (looked up ${res.code})`);
      } else {
        setTestResult(`No item for ${res.code}. Add a rule or link it from Quick Sale.`);
      }
    } catch (err) {
      setTestResult(errorMessage(err, "Couldn't check that code."));
    }
  };

  const preview = draft && testCode.trim() ? applyRule(draftToInput(draft), testCode) : null;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.intro}>
        Every store prints its own tags. Rules tell the scanner what your codes mean: trim a store prefix, keep the
        part that is your SKU, then find the item. Rules run top to bottom; the first one that finds an item wins.
        Scans that match no rule are still checked as UPC, SKU and linked barcodes.
      </Text>

      <Card>
        <SectionLabel>Test a scan</SectionLabel>
        <View style={styles.inline}>
          <TextInput
            value={testCode}
            onChangeText={(v) => { setTestCode(v); setTestResult(null); }}
            placeholder="Type or paste a barcode"
            placeholderTextColor={COLORS.textMuted}
            style={[styles.input, styles.flex]}
            autoCapitalize="characters"
            autoCorrect={false}
            testID="rule-test-input"
          />
          <Button label="Check" size="sm" onPress={() => void runTest()} />
        </View>
        {testResult ? <Text style={styles.result} testID="rule-test-result">{testResult}</Text> : null}
      </Card>

      {draft ? (
        <Card>
          <SectionLabel>{draft.id ? "Edit rule" : "New rule"}</SectionLabel>
          <Field label="Name" value={draft.name} onChange={(v) => set("name", v)} placeholder="Shelf tags" testID="rule-name" />
          <View style={styles.inline}>
            <Field label="Starts with" value={draft.prefix} onChange={(v) => set("prefix", v)} placeholder="STR-" caps testID="rule-prefix" />
            <Field label="Ends with" value={draft.suffix} onChange={(v) => set("suffix", v)} placeholder="/A" caps testID="rule-suffix" />
          </View>
          <Toggle label="Remove the 'starts with' part" value={draft.stripPrefix} onChange={(v) => set("stripPrefix", v)} />
          <Toggle label="Remove the 'ends with' part" value={draft.stripSuffix} onChange={(v) => set("stripSuffix", v)} />
          <View style={styles.inline}>
            <Field label="Shortest length" value={draft.minLength} onChange={(v) => set("minLength", v)} numeric />
            <Field label="Longest length" value={draft.maxLength} onChange={(v) => set("maxLength", v)} numeric />
          </View>
          <View style={styles.inline}>
            <Field label="Keep from character #" value={draft.sliceStart} onChange={(v) => set("sliceStart", v)} numeric />
            <Field label="How many characters" value={draft.sliceLength} onChange={(v) => set("sliceLength", v)} numeric />
          </View>
          <Text style={styles.fieldLabel}>Look up the result as</Text>
          <View style={styles.chips}>
            {(Object.keys(LOOKUP_LABELS) as LookupField[]).map((key) => (
              <TouchableOpacity
                key={key}
                style={[styles.chip, draft.lookup === key && styles.chipOn]}
                onPress={() => set("lookup", key)}
                accessibilityRole="button"
                accessibilityState={{ selected: draft.lookup === key }}
              >
                <Text style={[styles.chipText, draft.lookup === key && styles.chipTextOn]}>{LOOKUP_LABELS[key]}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {testCode.trim() ? (
            <Text style={styles.result} testID="rule-preview">
              {preview ? `${testCode.trim().toUpperCase()} → ${preview}` : "This rule doesn't apply to the test code."}
            </Text>
          ) : null}
          <Button label="Save rule" onPress={() => void save()} loading={saving} fullWidth />
          <Button label="Cancel" variant="ghost" onPress={() => setDraft(null)} fullWidth />
        </Card>
      ) : (
        <Button label="Add a rule" leadingIcon="add-circle-outline" onPress={() => setDraft({ ...EMPTY })} fullWidth />
      )}

      <SectionLabel>Your rules</SectionLabel>
      {loading ? <ActivityIndicator color={COLORS.primary} /> : null}
      {!loading && rules.length === 0 ? (
        <Text style={styles.empty}>No rules yet. Scans still match UPCs, SKUs and barcodes you link from Quick Sale.</Text>
      ) : null}
      {rules.map((rule, index) => (
        <Card key={rule.id}>
          <View style={styles.ruleHead}>
            <TouchableOpacity style={styles.flex} onPress={() => setDraft(ruleToDraft(rule))} accessibilityRole="button">
              <Text style={styles.ruleName}>{rule.name}</Text>
              <Text style={styles.ruleMeta}>{describeRule(rule)}</Text>
            </TouchableOpacity>
            <Switch value={rule.enabled} onValueChange={(v) => void toggle(rule, v)} accessibilityLabel={`Use ${rule.name}`} />
          </View>
          <View style={styles.ruleActions}>
            <IconButton icon="arrow-up" label="Move up" onPress={() => void move(index, -1)} disabled={index === 0} />
            <IconButton icon="arrow-down" label="Move down" onPress={() => void move(index, 1)} disabled={index === rules.length - 1} />
            <IconButton icon="trash-outline" label={`Delete ${rule.name}`} onPress={() => remove(rule)} />
          </View>
        </Card>
      ))}
    </ScrollView>
  );
}

function Field({
  label, value, onChange, placeholder, numeric, caps, testID,
}: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; numeric?: boolean; caps?: boolean; testID?: string;
}) {
  return (
    <View style={styles.flex}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={(v) => onChange(numeric ? v.replace(/\D/g, "").slice(0, 2) : v)}
        placeholder={placeholder}
        placeholderTextColor={COLORS.textMuted}
        keyboardType={numeric ? "number-pad" : "default"}
        autoCapitalize={caps ? "characters" : "sentences"}
        autoCorrect={false}
        style={styles.input}
        accessibilityLabel={label}
        testID={testID}
      />
    </View>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.toggle}>
      <Text style={styles.toggleText}>{label}</Text>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={label} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.md, gap: SPACING.md, paddingBottom: SPACING.xl * 2 },
  intro: { ...TYPE.caption, color: COLORS.textSoft },
  flex: { flex: 1 },
  inline: { flexDirection: "row", gap: SPACING.sm, alignItems: "flex-end" },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADII.md,
    paddingHorizontal: SPACING.sm,
    minHeight: 44,
    color: COLORS.text,
  },
  fieldLabel: { ...TYPE.caption, color: COLORS.textMuted, marginBottom: SPACING.xxs, marginTop: SPACING.xs },
  result: { ...TYPE.body, color: COLORS.text, marginTop: SPACING.xs },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.xs, marginBottom: SPACING.sm },
  chip: {
    minHeight: 44, paddingHorizontal: SPACING.md, borderRadius: RADII.md,
    borderWidth: 1, borderColor: COLORS.border, justifyContent: "center",
  },
  chipOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  chipText: { ...TYPE.body, color: COLORS.text },
  chipTextOn: { color: "#FFFFFF", fontWeight: "700" },
  toggle: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 },
  toggleText: { ...TYPE.body, color: COLORS.text, flex: 1 },
  empty: { ...TYPE.caption, color: COLORS.textMuted },
  ruleHead: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  ruleName: { ...TYPE.body, color: COLORS.text, fontWeight: "700" },
  ruleMeta: { ...TYPE.caption, color: COLORS.textMuted },
  ruleActions: { flexDirection: "row", justifyContent: "flex-end", gap: SPACING.xs, marginTop: SPACING.xs },
});
