import { LoaderCircleIcon } from "lucide-react";

import { threadSyncLabel, type ThreadSyncPhase } from "../../threadSync";
import { ComposerBanner } from "./ComposerBanner";

export function ThreadSyncStatusPill({ phase }: { readonly phase: ThreadSyncPhase }) {
  const label = threadSyncLabel(phase);

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Surface
        aria-label={label}
        className="pointer-events-none flex items-center gap-2 px-3 pt-2 pb-[calc(var(--chat-composer-attachment-overlap)+0.375rem)] text-xs font-medium text-foreground sm:px-4"
        data-thread-sync-drawer="true"
        role="status"
      >
        <LoaderCircleIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{label}</span>
      </ComposerBanner.Surface>
    </ComposerBanner.Attachment>
  );
}
