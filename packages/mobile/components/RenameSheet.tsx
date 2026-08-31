import { useEffect } from "react";
import { BackHandler, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import KeyboardResponsiveView from "./KeyboardResponsiveView";

export default function RenameSheet({
  title,
  placeholder,
  value,
  onChangeText,
  onCancel,
  onSave,
}: {
  title: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onCancel();
      return true;
    });
    return () => subscription.remove();
  }, [onCancel]);

  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 100, elevation: 100 }]}>
      <KeyboardResponsiveView androidBottomInset={0} iosVerticalOffset={0}>
        <View className="flex-1 justify-end">
          <Pressable style={StyleSheet.absoluteFill} className="bg-black/40" onPress={onCancel} />
          <View className="rounded-t-3xl bg-white px-4 pb-8 pt-3">
            <View className="mx-auto mb-2 h-1 w-10 rounded-full bg-zinc-200" />
            <Text className="mb-3 text-center text-sm font-semibold text-zinc-900">{title}</Text>
            <TextInput
              value={value}
              onChangeText={onChangeText}
              placeholder={placeholder}
              autoFocus
              selectTextOnFocus
              className="rounded-lg bg-zinc-100 px-3 py-2.5 text-sm text-zinc-900"
              onSubmitEditing={onSave}
              returnKeyType="done"
            />
            <View className="mt-4 flex-row gap-3">
              <Pressable onPress={onCancel} className="flex-1 items-center rounded-xl bg-zinc-100 py-3 active:opacity-70">
                <Text className="text-sm font-medium text-zinc-600">Cancel</Text>
              </Pressable>
              <Pressable onPress={onSave} className="flex-1 items-center rounded-xl bg-orange-500 py-3 active:opacity-90">
                <Text className="text-sm font-semibold text-white">Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardResponsiveView>
    </View>
  );
}
