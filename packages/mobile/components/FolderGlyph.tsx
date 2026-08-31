import { View } from "react-native";

// Drawn from two rounded rectangles — the app ships no icon font or SVG runtime,
// and a folder is simple enough geometry to build from a tab plus a body.
export default function FolderGlyph({ color = "#d4d4d8", size = 18 }: { color?: string; size?: number }) {
  const h = Math.round(size * 0.8);
  const tab = Math.round(size * 0.45);
  const lip = Math.max(2, Math.round(size * 0.16));
  return (
    <View style={{ width: size, height: h }}>
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: tab,
          height: lip + 2,
          borderTopLeftRadius: 2,
          borderTopRightRadius: 3,
          backgroundColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: lip,
          left: 0,
          right: 0,
          bottom: 0,
          borderRadius: 3,
          backgroundColor: color,
        }}
      />
    </View>
  );
}
