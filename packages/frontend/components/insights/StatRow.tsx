import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Divider } from '@oxy.so/bloom/divider';
import { Item } from '@oxy.so/bloom/item';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { formatCompactNumber } from '@/utils/formatNumber';

export interface StatRowProps {
    /** A rendered glyph (18px in both insights surfaces). */
    icon: React.ReactNode;
    label: string;
    /** A number is printed compact (`1.2K`); a string is printed as given. */
    value: string | number;
    /** A secondary reading right of the value — a share, a per-post rate. */
    sub?: string;
    /** A rule under the row; the last row of a group passes `false`. */
    showDivider?: boolean;
}

/**
 * One labelled figure in an insights list — the account dashboard
 * (`InsightsView`) and a single post's sheet (`PostInsightsSheet`) share this
 * row, so "a stat" looks the same wherever the app reports one.
 *
 * Built on Bloom's `Item` (leading glyph, 15/500 title, trailing slot) with the
 * row's side padding removed: the screens already inset their content, and the
 * rows sit flush with the section headings above them.
 */
export function StatRow({ icon, label, value, sub, showDivider = true }: StatRowProps) {
    const theme = useTheme();
    const reading = typeof value === 'number' ? formatCompactNumber(value) : value;
    return (
        <View>
            <Item
                leading={icon}
                title={label}
                // A labelled row would otherwise announce its title alone.
                accessibilityLabel={sub ? `${label}, ${reading}, ${sub}` : `${label}, ${reading}`}
                style={styles.row}
                trailing={
                    <View style={styles.trailing}>
                        <Text variant="headline-bold">{reading}</Text>
                        {sub ? (
                            <Text
                                variant="body-2-medium"
                                style={[styles.sub, { color: theme.colors.textSecondary }]}
                            >
                                {sub}
                            </Text>
                        ) : null}
                    </View>
                }
            />
            {showDivider ? <Divider /> : null}
        </View>
    );
}

const styles = StyleSheet.create({
    // Same spellings `Item` uses (side longhands, vertical shorthand): on web
    // react-native-web ranks a shorthand above a longhand whatever the array
    // order, so a mismatched spelling here would silently lose.
    row: {
        paddingLeft: 0,
        paddingRight: 0,
        paddingVertical: 12,
    },
    trailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    sub: {
        minWidth: 40,
        textAlign: 'right',
    },
});

export default StatRow;
