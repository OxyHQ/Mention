import { colors } from "@/styles/colors";
import React, { useState, useEffect, useRef } from "react";
import { View, Text, TouchableOpacity, Image, StyleSheet, Modal, Video as RNVideo, ScrollView, PanResponder, Platform, ImageStyle } from "react-native";

const AutoWidthImage = ({ uri, style }) => {
    const [width, setWidth] = useState(0);

    useEffect(() => {
        Image.getSize(uri, (imgWidth, imgHeight) => {
            const calculatedWidth = (250 * imgWidth) / imgHeight;
            setWidth(calculatedWidth);
        });
    }, [uri]);

    return (
        <Image
            source={{ uri }}
            style={[
                {
                    height: 250,
                    width: width || "auto",
                    resizeMode: "contain",
                    borderRadius: 35,
                    borderWidth: 1,
                    borderColor: colors.COLOR_BLACK_LIGHT_6,
                },
                style,
            ]}
        />
    );
};

export default AutoWidthImage;