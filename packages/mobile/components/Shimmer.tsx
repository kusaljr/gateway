import { useEffect, useState, type PropsWithChildren } from "react";
import { View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";

// Sweeps a band of the surface's own colour across whatever it wraps, so the
// text underneath dims and brightens. It measures its own box — wrap the text
// itself, never a stretched container, or the sweep crosses empty space.
//
// `tint` must match the background it sits on: the band reads as the text
// fading, not as a white highlight laid over it.
export default function Shimmer({ children, tint = "rgba(250,250,250,0.82)" }: PropsWithChildren<{ tint?: string }>) {
  const [width, setWidth] = useState(0);
  const translateX = useSharedValue(-72);
  useEffect(() => {
    if (!width) return;
    translateX.value = -72;
    translateX.value = withRepeat(withTiming(width + 72, { duration: 1300, easing: Easing.linear }), -1, false);
  }, [translateX, width]);
  const shimmerStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }, { skewX: "-14deg" }] }));
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ overflow: "hidden" }}>
      {children}
      <Animated.View
        pointerEvents="none"
        style={[
          { position: "absolute", top: -4, bottom: -4, left: 0, width: 52, backgroundColor: tint },
          shimmerStyle,
        ]}
      />
    </View>
  );
}
