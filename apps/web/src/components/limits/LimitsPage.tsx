import { RefreshCwIcon } from "lucide-react";

import { formatCount, formatPercent, formatTokens } from "@t3tools/shared/usageFormat";

import { isElectron } from "../../env";
import { useProviderLimits, type ProviderLimitsRow } from "../../state/providerLimits";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

/** `1788414600` to `10:50 PM` or `Sep 7, 3:00 PM` when it is not today. */
function formatReset(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat("en-US", {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** `2026-09-02T21:14:03Z` to `3m ago`. */
function formatAge(observedAt: string): string {
  const ms = Date.now() - Date.parse(observedAt);
  if (Number.isNaN(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function barColor(utilization: number): string {
  if (utilization >= 1) return "bg-destructive";
  if (utilization >= 0.8) return "bg-amber-500";
  return "bg-primary";
}

function AccountCard(props: { row: ProviderLimitsRow; showEnvironment: boolean }) {
  const { snapshot } = props.row;
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex items-baseline justify-between gap-4">
        <span className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full bg-muted-foreground"
            {...(props.row.accentColor
              ? { style: { backgroundColor: props.row.accentColor } }
              : {})}
          />
          <span className="truncate text-sm font-medium text-foreground">
            {props.row.displayName}
          </span>
          {snapshot.planType ? (
            <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {snapshot.planType}
            </span>
          ) : null}
          {snapshot.status === "rejected" ? (
            <span className="shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-[11px] text-destructive">
              limit reached
            </span>
          ) : null}
        </span>
        <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground tabular-nums">
          {props.showEnvironment ? `${props.row.environmentLabel} · ` : ""}
          {formatAge(snapshot.observedAt)}
        </span>
      </div>

      {snapshot.windows.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          {snapshot.windows.map((window) => (
            <div key={window.key} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-4 text-xs">
                <span className="truncate text-muted-foreground">{window.label}</span>
                <span className="shrink-0 text-foreground tabular-nums">
                  {formatPercent(Math.min(window.utilization, 1), 0)}
                  {window.resetsAt === undefined ? "" : ` · resets ${formatReset(window.resetsAt)}`}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full ${barColor(window.utilization)}`}
                  style={{ width: `${Math.min(Math.max(window.utilization, 0), 1) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        // Antigravity publishes no quota, so tokens T3 has driven through the
        // account are the only signal available for it.
        <div className="flex items-baseline justify-between gap-4 text-xs">
          <span className="text-muted-foreground">
            No quota reported · {formatCount(snapshot.turns ?? 0)}{" "}
            {snapshot.turns === 1 ? "turn" : "turns"} since server start
          </span>
          <span className="shrink-0 text-foreground tabular-nums">
            {formatTokens(snapshot.tokensUsed ?? 0)} tokens
          </span>
        </div>
      )}
    </section>
  );
}

export function LimitsPage() {
  const { rows, environmentIds, isPending, errors, refresh } = useProviderLimits();
  const showEnvironment = environmentIds.length > 1;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full min-w-0 items-center gap-3">
            <WorkspaceBreadcrumb ariaLabel="Limits breadcrumb" className="min-w-0">
              <WorkspaceBreadcrumbItem current>
                <h1>Limits</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <div className="ms-auto flex shrink-0 items-center">
              <Button
                onClick={refresh}
                aria-label="Refresh account limits"
                size="icon-sm"
                variant="ghost"
              >
                <RefreshCwIcon className="size-3.5" />
              </Button>
            </div>
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            <div className="flex flex-col gap-4">
              {errors.map((error) => (
                <p key={error} className="text-xs text-destructive">
                  {error}
                </p>
              ))}

              {isPending ? (
                <p className="text-sm text-muted-foreground">Reading account limits…</p>
              ) : rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No account limits reported yet. Providers publish their quota while a turn runs,
                  so send a message and this page fills in.
                </p>
              ) : (
                rows.map((row) => (
                  <AccountCard
                    key={`${row.environmentId}:${row.snapshot.providerInstanceId}`}
                    row={row}
                    showEnvironment={showEnvironment}
                  />
                ))
              )}
            </div>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
