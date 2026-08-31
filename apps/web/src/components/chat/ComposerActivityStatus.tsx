import { LoaderCircleIcon } from "lucide-react";
import { threadSyncLabel, type ThreadSyncPhase } from "../../threadSync";
import { ComposerBanner } from "./ComposerBanner";

export type ComposerActivityStatus = { readonly kind: "sync"; readonly phase: ThreadSyncPhase };

export function ComposerActivityIcon() {
  return (
    <ComposerBanner.Icon>
      <LoaderCircleIcon className="motion-safe:animate-spin" />
    </ComposerBanner.Icon>
  );
}

export function ComposerActivityRow({ status }: { readonly status: ComposerActivityStatus }) {
  return (
    <ComposerBanner.Row>
      <ComposerActivityIcon />
      <ComposerBanner.Content>
        <ComposerActivityLabel status={status} />
      </ComposerBanner.Content>
    </ComposerBanner.Row>
  );
}

export function ComposerActivityLabel({ status }: { readonly status: ComposerActivityStatus }) {
  return (
    <span
      className="shrink-0 whitespace-nowrap text-muted-foreground"
      data-composer-sync-status={status.phase}
      role="status"
    >
      {threadSyncLabel(status.phase)}
    </span>
  );
}
