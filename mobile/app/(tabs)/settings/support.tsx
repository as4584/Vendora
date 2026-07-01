import { useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput } from "react-native";

import { ActionButton, Card, HeaderTitle, Pill, SectionLabel } from "../../../components/ui";
import { useAuth } from "../../../context/auth";
import * as api from "../../../services/api";
import { COLORS, SPACING } from "../../../theme/tokens";

export default function SupportScreen() {
  const { user } = useAuth();
  const [subject, setSubject] = useState(""); const [message, setMessage] = useState(""); const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (subject.trim().length < 3 || message.trim().length < 10) { Alert.alert("More detail needed", "Add a subject and at least 10 characters describing the issue."); return; }
    setSaving(true);
    try { const result = await api.submitSupportRequest(subject.trim(), message.trim()); setSubject(""); setMessage(""); Alert.alert("Request received", `${result.priority === "priority" ? "Priority" : "Standard"} ticket ${result.id.slice(0, 8)} is open.`); }
    catch (error: any) { Alert.alert("Request failed", error?.message || "Could not submit your support request."); }
    finally { setSaving(false); }
  };
  return <ScrollView testID="support-content" style={styles.container} contentContainerStyle={styles.content}>
    <HeaderTitle title="Vendora Support" subtitle="Tell us what happened and the team will receive a tracked request." />
    <Card style={styles.card}><SectionLabel>Service level</SectionLabel><Pill label={user?.is_partner ? "PRIORITY" : "STANDARD"} tone={user?.is_partner ? "success" : "neutral"} /><Text style={styles.help}>{user?.is_partner ? "Partner requests are marked priority for the support team." : "Upgrade to Partner for priority routing."}</Text></Card>
    <Card style={styles.card}><Text style={styles.label}>Subject</Text><TextInput accessibilityLabel="Support subject" value={subject} onChangeText={setSubject} maxLength={160} style={styles.input} placeholder="What do you need help with?" placeholderTextColor={COLORS.textMuted} /><Text style={styles.label}>Details</Text><TextInput accessibilityLabel="Support message" value={message} onChangeText={setMessage} maxLength={5000} multiline style={[styles.input, styles.message]} placeholder="Steps, expected result, and what happened..." placeholderTextColor={COLORS.textMuted} /><ActionButton label={saving ? "Submitting..." : "Submit Request"} onPress={submit} disabled={saving} /></Card>
  </ScrollView>;
}
const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: COLORS.bg }, content: { padding: SPACING.lg, gap: SPACING.md, paddingBottom: 48 }, card: { gap: SPACING.sm }, help: { color: COLORS.textMuted, fontSize: 12, lineHeight: 18 }, label: { color: COLORS.textSoft, fontSize: 12, fontWeight: "700" }, input: { backgroundColor: COLORS.bgElevated, borderColor: COLORS.border, borderWidth: 1, borderRadius: 12, color: COLORS.text, padding: 12 }, message: { minHeight: 150, textAlignVertical: "top" } });
