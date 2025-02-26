import React, { useMemo } from "react";
import { BottomSheetBackgroundProps } from "@gorhom/bottom-sheet";
import Animated, {
    useAnimatedStyle,
    interpolateColor,
} from "react-native-reanimated";
import { colors } from "@/styles/colors";

const CustomBackground: React.FC<BottomSheetBackgroundProps> = ({
    style,
    animatedIndex,
}) => {
    return <Animated.View pointerEvents="none" style={{ backgroundColor: "red" }} />;
};

export default CustomBackground;