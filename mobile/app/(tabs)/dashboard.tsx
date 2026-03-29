/**
 * Dashboard Screen — Sprint 2
 *
 * Shows revenue today/week/month, net profit, inventory value, and key counts.
 */
import { useCallback, useEffect, useState } from "react";
import {
    View,
    Text,
    ScrollView,
    StyleSheet,
    ActivityIndicator,
    RefreshControl,
    Alert,
} from "react-native";
import * as api from "../../services/api";

function MetricCard({
    label,
    value,
    prefix = "$",
    color = "#FFFFFF",
}: {
    label: string;
    value: string | number;
    prefix?: string;
    color?: string;
}) {
    const display = typeof value === "number" ? value.toString() : value;
    const isNegative = display.startsWith("-");

    return (
        <View style={styles.metricCard}>
            <Text style={styles.metricLabel}>{label}</Text>
            <Text style={[styles.metricValue, { color: isNegative ? "#E17055" : color }]}>
                {prefix}
                {display}
            </Text>
        </View>
    );
}

/** Margin % card — colour-coded by threshold. */
function MarginCard({
    label,
    pct,
    subtitle,
}: {
    label: string;
    pct: number | null;
    subtitle?: string;
}) {
    const color =
        pct === null ? "#888"
        : pct >= 30 ? "#00B894"
        : pct >= 15 ? "#FDCB6E"
        : "#E17055";

    return (
        <View style={[styles.metricCard, { borderColor: color + "55" }]}>
            <Text style={styles.metricLabel}>{label}</Text>
            <Text style={[styles.metricValue, { color }]}>
                {pct !== null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%` : "—"}
            </Text>
            {subtitle && <Text style={styles.metricSubtitle}>{subtitle}</Text>}
        </View>
    );
}

function CountCard({
    label,
    value,
    emoji,
}: {
    label: string;
    value: number;
    emoji: string;
}) {
    return (
        <View style={styles.countCard}>
            <Text style={styles.countEmoji}>{emoji}</Text>
            <Text style={styles.countValue}>{value}</Text>
            <Text style={styles.countLabel}>{label}</Text>
        </View>
    );
}

export default function DashboardScreen() {
    const [data, setData] = useState<api.Dashboard | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);

    const fetchDashboard = useCallback(async () => {
        try {
            const d = await api.getDashboard();
            setData(d);
        } catch (err: any) {
            Alert.alert("Error", err.message || "Failed to load dashboard.");
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    useEffect(() => {
        fetchDashboard();
    }, []);

    const onRefresh = () => {
        setRefreshing(true);
        fetchDashboard();
    };

    if (loading || !data) {
        return (
            <View style={styles.center}>
                <ActivityIndicator size="large" color="#6C5CE7" />
            </View>
        );
    }

    return (
        <ScrollView
            style={styles.container}
            contentContainerStyle={styles.content}
            refreshControl={
                <RefreshControl
                    refreshing={refreshing}
                    onRefresh={onRefresh}
                    tintColor="#6C5CE7"
                    colors={["#6C5CE7"]}
                />
            }
        >
            {/* Revenue Section */}
            <Text style={styles.sectionTitle}>💰 Revenue</Text>
            <View style={styles.row}>
                <MetricCard label="Today" value={data.revenue_today} color="#00B894" />
                <MetricCard label="This Week" value={data.revenue_week} color="#00B894" />
            </View>
            <View style={styles.row}>
                <MetricCard label="This Month" value={data.revenue_month} color="#00B894" />
            </View>

            {/* Profit Section */}
            <Text style={styles.sectionTitle}>📊 Net Profit</Text>
            <View style={styles.row}>
                <MetricCard label="Today" value={data.net_profit_today} color="#6C5CE7" />
                <MetricCard label="This Week" value={data.net_profit_week} color="#6C5CE7" />
            </View>
            <View style={styles.row}>
                <MetricCard label="This Month" value={data.net_profit_month} color="#6C5CE7" />
                <MetricCard label="All Time" value={data.net_profit_all_time} color="#6C5CE7" />
            </View>

            {/* Inventory Value */}
            <Text style={styles.sectionTitle}>📦 Inventory</Text>
            <View style={styles.row}>
                <MetricCard label="Total Cost" value={data.total_inventory_value} color="#0984E3" />
                <MetricCard label="Expected Value" value={data.total_expected_value} color="#0984E3" />
            </View>
            <View style={styles.row}>
                <MetricCard label="Potential Profit" value={data.potential_profit} color="#00B894" />
            </View>

            {/* Margin % — computed client-side from existing response fields */}
            {(() => {
                const cost = parseFloat(data.total_inventory_value as any);
                const expected = parseFloat(data.total_expected_value as any);
                const profit = parseFloat(data.potential_profit as any);
                // Gross margin %: profit / expected * 100
                const grossMargin = expected > 0 ? (profit / expected) * 100 : null;
                // Markup %: profit / cost * 100
                const markup = cost > 0 ? (profit / cost) * 100 : null;
                return (
                    <View style={styles.row}>
                        <MarginCard
                            label="Gross Margin %"
                            pct={grossMargin !== null ? Math.round(grossMargin * 10) / 10 : null}
                            subtitle="Profit ÷ Expected"
                        />
                        <MarginCard
                            label="Markup %"
                            pct={markup !== null ? Math.round(markup * 10) / 10 : null}
                            subtitle="Profit ÷ Cost"
                        />
                    </View>
                );
            })()}

            {/* Counts */}
            <Text style={styles.sectionTitle}>📈 Overview</Text>
            <View style={styles.countsRow}>
                <CountCard label="Total" value={data.total_items} emoji="📦" />
                <CountCard label="In Stock" value={data.items_in_stock} emoji="🏠" />
                <CountCard label="Listed" value={data.items_listed} emoji="🏷️" />
                <CountCard label="Sold" value={data.items_sold} emoji="✅" />
            </View>

            {/* Transaction counts */}
            <View style={styles.row}>
                <MetricCard label="Transactions" value={data.total_transactions} prefix="" color="#FDCB6E" />
                <MetricCard label="Refunds" value={data.total_refunds} prefix="" color="#E17055" />
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: "#0A0A1A",
    },
    content: {
        padding: 16,
        paddingBottom: 40,
    },
    center: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: "#0A0A1A",
    },
    sectionTitle: {
        fontSize: 16,
        fontWeight: "800",
        color: "#FFFFFF",
        marginTop: 20,
        marginBottom: 12,
    },
    row: {
        flexDirection: "row",
        gap: 12,
        marginBottom: 12,
    },
    metricCard: {
        flex: 1,
        backgroundColor: "#1A1A2E",
        borderRadius: 14,
        padding: 16,
        borderWidth: 1,
        borderColor: "#2A2A4A",
    },
    metricLabel: {
        color: "#888",
        fontSize: 12,
        fontWeight: "600",
        textTransform: "uppercase",
        letterSpacing: 0.5,
        marginBottom: 6,
    },
    metricValue: {
        fontSize: 24,
        fontWeight: "800",
    },
    metricSubtitle: {
        color: "#666",
        fontSize: 10,
        marginTop: 4,
    },
    countsRow: {
        flexDirection: "row",
        gap: 10,
        marginBottom: 16,
    },
    countCard: {
        flex: 1,
        backgroundColor: "#1A1A2E",
        borderRadius: 12,
        padding: 12,
        alignItems: "center",
        borderWidth: 1,
        borderColor: "#2A2A4A",
    },
    countEmoji: {
        fontSize: 20,
        marginBottom: 4,
    },
    countValue: {
        fontSize: 22,
        fontWeight: "800",
        color: "#FFFFFF",
    },
    countLabel: {
        fontSize: 10,
        fontWeight: "600",
        color: "#888",
        textTransform: "uppercase",
        marginTop: 2,
    },
});
