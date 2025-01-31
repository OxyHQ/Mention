import React, { useState } from 'react'
import { View, TextInput, Platform, ViewStyle } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors } from '../styles/colors'

export const SearchBar = () => {
    const [searchQuery, setSearchQuery] = useState('');

    const handleSearchChange = (query: string) => {
        setSearchQuery(query);
        // Add logic to handle search query, e.g., API call or filtering data
    };

    return (
        <View
            style={
                {
                    backgroundColor: colors.COLOR_BACKGROUND,
                    flexDirection: 'row',
                    justifyContent: 'center',
                    alignItems: 'center',
                    ...Platform.select({
                        web: {
                            position: 'sticky',
                        },
                    }),
                    marginTop: 20,
                    top: 0,
                    zIndex: 1000,
                    paddingVertical: 4,
                    width: '100%',
                } as ViewStyle
            }>
            <View
                style={{
                    backgroundColor: colors.primaryLight,
                    borderRadius: 100,
                    height: 45,
                    flexDirection: 'row',
                    justifyContent: 'flex-start',
                    alignItems: 'center',
                    paddingStart: 15,
                    flex: 1,
                }}>
                <Ionicons name="search" fill={colors.COLOR_BLACK_LIGHT_4} width={20} height={20} />
                <TextInput
                    style={{
                        fontSize: 16,
                        color: colors.COLOR_BLACK_LIGHT_4,
                        marginHorizontal: 17,
                        flex: 1,
                    }}
                    placeholder="Search Mention"
                    value={searchQuery}
                    onChangeText={handleSearchChange}
                />
            </View>
        </View>
    )
}
