/**
 * Live account limits across every connected environment.
 *
 * Each environment answers with the last quota reading its providers pushed,
 * which is a cheap in-memory read rather than the transcript scan behind
 * `state/usage`. Rows are decorated here with the instance's display name and
 * accent color so the page renders "Antigravity Main" instead of `agy_a1`.
 *
 * @module state/providerLimits
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderLimitsSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { deriveProviderInstanceEntries } from "../providerInstances";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface ProviderLimitsRow {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly displayName: string;
  readonly accentColor: string | undefined;
  readonly snapshot: ProviderLimitsSnapshot;
}

export interface ProviderLimitsView {
  readonly rows: readonly ProviderLimitsRow[];
  readonly environmentIds: readonly EnvironmentId[];
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  readonly errors: readonly string[];
  readonly refresh: () => void;
}

const providerLimitsAtom = Atom.make((get): ProviderLimitsView => {
  const presentations = get(environmentPresentations.presentationsAtom);

  const rows: ProviderLimitsRow[] = [];
  const environmentIds: EnvironmentId[] = [];
  const errors: string[] = [];
  let answered = 0;

  for (const [environmentId, presentation] of presentations) {
    environmentIds.push(environmentId);
    const environmentLabel = presentation.entry.target.label;
    const result = get(serverEnvironment.providerLimits({ environmentId, input: {} }));
    if (result._tag === "Failure") {
      errors.push(`${environmentLabel} could not report account limits.`);
      continue;
    }
    const report = Option.getOrNull(AsyncResult.value(result));
    if (report === null) continue;
    answered += 1;

    const entries = new Map(
      deriveProviderInstanceEntries(
        get(serverEnvironment.providersValueAtom(environmentId)) ?? [],
      ).map((entry) => [entry.instanceId as string, entry] as const),
    );
    for (const snapshot of report.snapshots) {
      const entry = entries.get(snapshot.providerInstanceId);
      rows.push({
        environmentId,
        environmentLabel,
        displayName: entry?.displayName ?? snapshot.providerInstanceId,
        accentColor: entry?.accentColor,
        snapshot,
      });
    }
  }

  // Sort by the account's own name so rows keep their place as readings land,
  // rather than reshuffling every time one provider reports.
  rows.sort((left, right) => left.displayName.localeCompare(right.displayName));

  return {
    rows,
    environmentIds,
    isPending: answered === 0 && errors.length === 0 && presentations.size > 0,
    errors,
    refresh: () => {},
  };
}).pipe(Atom.withLabel("web-provider-limits"));

export function useProviderLimits(): ProviderLimitsView {
  const view = useAtomValue(providerLimitsAtom);

  // Refreshing the derived atom alone re-reads the per-environment queries
  // within their stale window and changes nothing, so refresh each query.
  const refresh = useCallback(() => {
    for (const environmentId of view.environmentIds) {
      appAtomRegistry.refresh(serverEnvironment.providerLimits({ environmentId, input: {} }));
    }
  }, [view.environmentIds]);

  return { ...view, refresh };
}
