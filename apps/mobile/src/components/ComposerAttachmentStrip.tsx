import { SymbolView } from "../components/AppSymbol";
import { videoMimeType } from "@t3tools/shared/video";
import { Image, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "./AppText";
import type { DraftComposerAttachment, DraftComposerFileAttachment } from "../lib/composerImages";
import { VideoAttachmentTile } from "./VideoAttachmentTile";

export interface ComposerAttachmentStripProps {
  /** Attachments to display. */
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  /** Called when the user removes an attachment. */
  readonly onRemove: (imageId: string) => void;
  /** Called when the user taps on an image thumbnail to preview it. */
  readonly onPressImage?: (previewUri: string) => void;
  readonly onPressVideo?: (attachment: DraftComposerFileAttachment) => void;
  /** Image thumbnail size in points.  Defaults to 72. */
  readonly imageSize?: number;
  /** Border radius of each image thumbnail.  Defaults to 16. */
  readonly imageBorderRadius?: number;
  /** Whether the remove button should sit in its own gutter instead of overlapping the image. */
  readonly removeButtonPlacement?: "overlay" | "gutter";
}

export function ComposerAttachmentThumbnail(props: {
  readonly attachment: DraftComposerAttachment;
  readonly size: number;
  readonly borderRadius: number;
  readonly compact?: boolean;
  readonly onPressImage?: (previewUri: string) => void;
  readonly onPressVideo?: (attachment: DraftComposerFileAttachment) => void;
}) {
  const { attachment } = props;
  const style = { width: props.size, height: props.size, borderRadius: props.borderRadius };
  if (attachment.type === "image") {
    return (
      <Pressable
        onPress={props.onPressImage ? () => props.onPressImage?.(attachment.previewUri) : undefined}
      >
        <Image
          source={{ uri: attachment.previewUri }}
          style={style}
          className="bg-subtle"
          resizeMode="cover"
        />
      </Pressable>
    );
  }
  const onPressVideo = props.onPressVideo;
  if (onPressVideo && videoMimeType(attachment) !== null) {
    return props.compact ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Play ${attachment.name}`}
        onPress={() => onPressVideo(attachment)}
        style={style}
        className="items-center justify-center bg-black/80"
      >
        <SymbolView name="play" size={15} tintColor="#ffffff" type="monochrome" />
      </Pressable>
    ) : (
      <VideoAttachmentTile
        name={attachment.name}
        onPress={() => onPressVideo(attachment)}
        style={style}
      />
    );
  }
  return (
    <View
      className={
        props.compact
          ? "items-center justify-center bg-subtle"
          : "items-center justify-center gap-1 bg-subtle px-2"
      }
      style={style}
    >
      <SymbolView
        name="doc.text"
        size={props.compact ? 15 : 22}
        tintColor="#a3a3a3"
        type="monochrome"
      />
      {!props.compact ? (
        <Text className="w-full text-center text-2xs text-foreground" numberOfLines={1}>
          {attachment.name}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Attachment thumbnails used by the thread composer and the new-task draft screen.
 */
export function ComposerAttachmentStrip(props: ComposerAttachmentStripProps) {
  const size = props.imageSize ?? 72;
  const radius = props.imageBorderRadius ?? 16;
  const removeButtonPlacement = props.removeButtonPlacement ?? "overlay";
  const removeButtonGutter = removeButtonPlacement === "gutter" ? 10 : 0;

  if (props.attachments.length === 0) {
    return null;
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      className="grow-0"
    >
      <View className="flex-row gap-2.5">
        {props.attachments.map((attachment) => (
          <View
            key={attachment.id}
            className="relative"
            style={{
              paddingTop: removeButtonGutter,
              paddingRight: removeButtonGutter,
            }}
          >
            <ComposerAttachmentThumbnail
              attachment={attachment}
              size={size}
              borderRadius={radius}
              onPressImage={props.onPressImage}
              onPressVideo={props.onPressVideo}
            />
            <Pressable
              className="absolute h-[22px] w-[22px] items-center justify-center rounded-[11px] bg-black/55"
              style={{
                top: removeButtonPlacement === "gutter" ? 0 : 4,
                right: removeButtonPlacement === "gutter" ? 0 : 4,
              }}
              hitSlop={6}
              onPress={() => props.onRemove(attachment.id)}
            >
              <SymbolView
                name="xmark"
                size={9}
                tintColor="#ffffff"
                type="monochrome"
                weight="bold"
              />
            </Pressable>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
