import { Pressable, View, type StyleProp, type ViewStyle } from "react-native";

import { cn } from "../lib/cn";
import { SymbolView } from "./AppSymbol";
import { AppText } from "./AppText";

export function VideoAttachmentTile(props: {
  readonly name: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Play ${props.name}`}
      accessibilityState={{ disabled: props.disabled ?? false }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn("items-center justify-center overflow-hidden bg-black/80", props.className)}
      style={props.style}
    >
      <View className="size-12 items-center justify-center rounded-full bg-white/15">
        <SymbolView name="play" size={24} tintColor="#ffffff" type="monochrome" />
      </View>
      <AppText
        className="absolute inset-x-2 bottom-2 text-center text-xs text-white"
        numberOfLines={1}
      >
        {props.name}
      </AppText>
    </Pressable>
  );
}
