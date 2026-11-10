/**
 * Google Sheets sync surfaces: the Settings card (connect, create or link a
 * sheet, sync now, source-of-truth toggle) and a small prompt used on the
 * empty inventory and Import screens so sellers who already track stock in a
 * spreadsheet find it. Runs and push errors live in Sync Center.
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Platform, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import * as Linking from "expo-linking";
import * as api from "../services/api";
import { openProviderConnect } from "../utils/oauthConnect";
import { Button } from "./Button";
import { Card, Pill } from "./ui";
import { COLORS, FONT_SCALE, RADII, SPACING, TYPE } from "../theme/tokens";

export const SOURCE_OF_TRUTH_HELP =
  "When on, edits made in the sheet win over the app; when off, the app keeps the sheet updated but ignores sheet edits.";
export const EXISTING_SHEET_HELP =
  "Google only lets Resqlo open sheets it created for you. To keep using an existing sheet, import it first, then create a Resqlo sheet.";

function errorText(err: unknown, fallback: string): string {
  return (err as { message?: string } | null)?.message || fallback;
}

export function lastSyncLabel(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "Not synced yet";
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "Synced just now";
  if (minutes < 60) return `Synced ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Synced ${hours}h ago`;
  return `Synced ${Math.floor(hours / 24)}d ago`;
}

export function syncSummary(result: api.GoogleSheetsSyncResult): string {
  const parts = [
    result.created ? `${result.created} new` : null,
    result.updated ? `${result.updated} updated` : null,
    result.archived ? `${result.archived} archived` : null,
    result.appended ? `${result.appended} added to the sheet` : null,
  ].filter(Boolean);
  const head = parts.length ? parts.join(", ") : "Everything already matches.";
  return result.note ? `${head}\n${result.note}` : head;
}

type CardState = "loading" | "error" | "unconfigured" | "disconnected" | "unlinked" | "linked";

function cardState(status: api.GoogleSheetsStatus | null, failed: boolean): CardState {
  if (failed) return "error";
  if (!status) return "loading";
  if (!status.configured) return "unconfigured";
  if (!status.connected) return "disconnected";
  return status.sheet ? "linked" : "unlinked";
}

export function GoogleSheetsSettingsCard() {
  const [status, setStatus] = useState<api.GoogleSheetsStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [url, setUrl] = useState("");

  const reload = useCallback(async () => {
    try {
      setStatus(await api.getGoogleSheetsStatus());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void reload(); }, [reload]);

  const run = async (key: string, action: () => Promise<unknown>, failTitle: string) => {
    setBusy(key);
    try {
      await action();
    } catch (err) {
      Alert.alert(failTitle, errorText(err, "Try again in a moment."));
    } finally {
      setBusy(null);
    }
  };

  const connect = () =>
    run("connect", async () => {
      const { authorization_url } = await api.getGoogleConnectUrl(Platform.OS === "web" ? "web" : "native");
      // Shared flow: native auth session, or a web popup that posts back.
      const outcome = await openProviderConnect(authorization_url);
      if (outcome === "denied") Alert.alert("Google not connected", "Google sign-in was cancelled or denied.");
      await reload();
    }, "Google unavailable");

  const create = () =>
    run("create", async () => {
      setStatus(await api.createGoogleSheet());
    }, "Could not create the sheet");

  const link = () =>
    run("link", async () => {
      setStatus(await api.linkGoogleSheet(url.trim()));
      setPasting(false);
      setUrl("");
    }, "Could not use that sheet");

  const toggle = (key: "source_of_truth" | "archive_missing", value: boolean) =>
    run(key, async () => {
      setStatus(await api.updateGoogleSheetSettings({ [key]: value }));
    }, "Could not save");

  const confirm = (title: string, body: string, label: string, action: () => Promise<unknown>) =>
    Alert.alert(title, body, [
      { text: "Cancel", style: "cancel" },
      { text: label, style: "destructive", onPress: () => run(label, async () => { await action(); await reload(); }, `${label} failed`) },
    ]);

  const state = cardState(status, failed);
  const sheet = status?.sheet ?? null;

  return (
    <Card style={{ gap: SPACING.sm }}>
      <View style={styles.rowBetween}>
        <Text style={styles.title} maxFontSizeMultiplier={FONT_SCALE.chrome}>Google Sheets</Text>
        {state === "loading" ? <ActivityIndicator size="small" color={COLORS.primary} /> : null}
        {state === "linked" ? <Pill label="Syncing" tone="success" /> : null}
        {state === "unlinked" ? <Pill label="Connected" tone="info" /> : null}
        {state === "disconnected" ? <Pill label="Not connected" tone="neutral" /> : null}
        {state === "unconfigured" ? <Pill label="Not configured" tone="warning" /> : null}
      </View>
      <Text style={styles.muted}>Keep inventory in a Google Sheet. The app reads and writes that sheet, so it stays the source of truth.</Text>
      {state === "error" ? <Text style={styles.muted}>Google Sheets status is unavailable right now.</Text> : null}
      {state === "unconfigured" ? <Text style={styles.muted}>Google Sheets sync is not set up on this server yet.</Text> : null}
      {state === "disconnected" ? (
        <Button label="Connect Google" onPress={connect} loading={busy === "connect"} size="sm" leadingIcon="logo-google" />
      ) : null}

      {state === "unlinked" ? (
        <>
          {status?.email ? <Text style={styles.muted}>Signed in as {status.email}</Text> : null}
          <Button label="Create a Resqlo sheet" onPress={create} loading={busy === "create"} size="sm" />
          {pasting ? (
            <View style={{ gap: SPACING.xs }}>
              <TextInput
                value={url}
                onChangeText={setUrl}
                placeholder="Paste the Google Sheets link"
                placeholderTextColor={COLORS.textSoft}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
                accessibilityLabel="Google Sheets link"
                maxFontSizeMultiplier={FONT_SCALE.control}
              />
              <Text style={styles.hint}>{EXISTING_SHEET_HELP}</Text>
              <View style={styles.actions}>
                <Button label="Use this sheet" onPress={link} loading={busy === "link"} disabled={url.trim().length < 10} size="sm" />
                <Button label="Cancel" onPress={() => setPasting(false)} variant="ghost" size="sm" />
              </View>
            </View>
          ) : (
            <Button label="Use an existing sheet" onPress={() => setPasting(true)} variant="secondary" size="sm" />
          )}
          <Button label="Disconnect Google" onPress={() => confirm("Disconnect Google?", "Your sheet and items stay as they are.", "Disconnect", api.disconnectGoogle)} variant="ghost" size="sm" />
        </>
      ) : null}

      {state === "linked" && sheet ? (
        <>
          <Text style={styles.body} numberOfLines={2}>{sheet.title || "Linked sheet"} · {sheet.tab}</Text>
          <Text style={styles.muted}>
            {lastSyncLabel(sheet.last_synced_at)}
            {status?.pending_pushes ? ` · ${status.pending_pushes} change(s) waiting` : ""}
            {status?.failed_pushes ? ` · ${status.failed_pushes} failed, see Sync Center` : ""}
          </Text>
          {sheet.last_error ? <Text style={styles.error}>Last sync problem: {sheet.last_error}</Text> : null}
          <View style={styles.actions}>
            {sheet.url ? (
              <Button label="Open in Sheets" onPress={() => void Linking.openURL(sheet.url!)} variant="secondary" size="sm" trailingIcon="open-outline" />
            ) : null}
          </View>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.body}>Sheet is the source of truth</Text>
              <Text style={styles.hint}>{SOURCE_OF_TRUTH_HELP}</Text>
            </View>
            <Switch
              value={sheet.source_of_truth}
              onValueChange={(v) => toggle("source_of_truth", v)}
              disabled={busy === "source_of_truth"}
              trackColor={{ true: COLORS.primary, false: COLORS.cardAlt }}
              accessibilityLabel="Sheet is the source of truth"
            />
          </View>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.body}>Archive items deleted from the sheet</Text>
              <Text style={styles.hint}>When off, removed rows are flagged in Sync Center for you to review.</Text>
            </View>
            <Switch
              value={sheet.archive_missing}
              onValueChange={(v) => toggle("archive_missing", v)}
              disabled={busy === "archive_missing"}
              trackColor={{ true: COLORS.primary, false: COLORS.cardAlt }}
              accessibilityLabel="Archive items deleted from the sheet"
            />
          </View>
          <View style={styles.actions}>
            <Button label="Unlink sheet" onPress={() => confirm("Unlink this sheet?", "The sheet and your items are kept; syncing stops.", "Unlink", api.unlinkGoogleSheet)} variant="ghost" size="sm" />
            <Button label="Disconnect" onPress={() => confirm("Disconnect Google?", "Syncing stops. Your sheet and items stay as they are.", "Disconnect", api.disconnectGoogle)} variant="ghost" size="sm" />
          </View>
        </>
      ) : null}
    </Card>
  );
}

/** Discovery prompt for sellers who already keep stock in a spreadsheet. */
export function GoogleSheetsPrompt({
  title = "Already track stock in a spreadsheet?",
  cta = "Connect Google Sheets",
  onPress,
}: { title?: string; cta?: string; onPress?: () => void }) {
  // Screens with a router pass onPress; otherwise the app's own settings link opens.
  const open = onPress ?? (() => void Linking.openURL(Linking.createURL("settings")));
  return (
    <View style={styles.prompt} testID="google-sheets-prompt">
      <Text style={styles.body}>{title}</Text>
      <Text style={styles.hint}>Link a Google Sheet and Resqlo keeps it in sync both ways. The sheet stays the source of truth.</Text>
      <Button label={cta} onPress={open} variant="secondary" size="sm" leadingIcon="grid-outline" />
    </View>
  );
}

const styles = StyleSheet.create({
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING.sm },
  title: { ...TYPE.headline, color: COLORS.text },
  body: { color: COLORS.text, fontSize: 14, fontWeight: "600" },
  muted: { color: COLORS.textMuted, fontSize: 13, lineHeight: 19 },
  hint: { color: COLORS.textSoft, fontSize: 12, lineHeight: 17 },
  error: { color: COLORS.danger, fontSize: 12, lineHeight: 17 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.sm },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  input: {
    borderWidth: 1, borderColor: COLORS.border, borderRadius: RADII.md, backgroundColor: COLORS.bgElevated,
    color: COLORS.text, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, fontSize: 14,
  },
  prompt: {
    gap: SPACING.xs, padding: SPACING.md, borderRadius: RADII.md, borderWidth: 1,
    borderColor: COLORS.border, backgroundColor: COLORS.bgElevated, alignSelf: "stretch",
  },
});
