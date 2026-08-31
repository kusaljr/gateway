import { type PropsWithChildren } from "react";
import { KeyboardAvoidingView, Platform } from "react-native";
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";

export default function KeyboardResponsiveView({
  androidBottomInset,
  iosVerticalOffset,
  children,
}: PropsWithChildren<{ androidBottomInset: number; iosVerticalOffset: number }>) {
  if (Platform.OS === "android") {
    return <AndroidKeyboardAvoidingView bottomInset={androidBottomInset}>{children}</AndroidKeyboardAvoidingView>;
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={iosVerticalOffset}>
      {children}
    </KeyboardAvoidingView>
  );
}

function AndroidKeyboardAvoidingView({ bottomInset, children }: PropsWithChildren<{ bottomInset: number }>) {
  // Android 15+ enforces edge-to-edge, where adjustResize can leave the root
  // window full-height. Track the IME inset directly so content ends at the
  // keyboard's top edge. SafeAreaView already consumes bottomInset.
  // react-native-edge-to-edge (on by default in this Expo/RN version) already
  // makes status/nav bars translucent — reanimated ignores (and warns on)
  // these flags once it detects that, so there's nothing for them to do here.
  const keyboard = useAnimatedKeyboard();
  const keyboardStyle = useAnimatedStyle(
    () => ({
      paddingBottom: Math.max(keyboard.height.value - bottomInset, 0),
    }),
    [bottomInset]
  );

  return <Animated.View style={[{ flex: 1 }, keyboardStyle]}>{children}</Animated.View>;
}
