import { isPathInside, type DiscoveryRecord } from "@pi-context/protocol";
import type { LivePi } from "./discovery.js";

export type RoutingDecision =
  | { readonly _tag: "target"; readonly target: LivePi }
  | { readonly _tag: "pick"; readonly candidates: ReadonlyArray<LivePi>; readonly mixedRoots: boolean }
  | { readonly _tag: "none" };

export const routeToPi = (
  instances: ReadonlyArray<LivePi>,
  canonicalFilePaths: ReadonlyArray<string>,
  rememberedInstanceId?: string
): RoutingDecision => {
  if (instances.length === 0) return { _tag: "none" };
  const remembered = instances.find((item) => item.record.instanceId === rememberedInstanceId);
  const containingAll = instances.filter((item) =>
    canonicalFilePaths.every((file) => isPathInside(file, item.record.canonicalWorkingDirectory))
  );

  if (remembered && containingAll.some((item) => item.record.instanceId === remembered.record.instanceId)) {
    return { _tag: "target", target: remembered };
  }
  if (containingAll.length === 1) return { _tag: "target", target: containingAll[0]! };
  if (containingAll.length > 1) {
    const deepest = [...containingAll].sort((left, right) =>
      right.record.canonicalWorkingDirectory.length - left.record.canonicalWorkingDirectory.length
    )[0]!;
    return { _tag: "target", target: deepest };
  }

  const perFileOwners = new Set(canonicalFilePaths.flatMap((file) =>
    instances.filter((item) => isPathInside(file, item.record.canonicalWorkingDirectory))
      .map((item) => item.record.instanceId)
  ));
  const mixedRoots = canonicalFilePaths.length > 1 && perFileOwners.size > 1;
  if (mixedRoots) return { _tag: "pick", candidates: instances, mixedRoots: true };
  if (remembered) return { _tag: "target", target: remembered };
  if (instances.length === 1) return { _tag: "target", target: instances[0]! };
  return { _tag: "pick", candidates: instances, mixedRoots: false };
};

export const recordLabel = (record: DiscoveryRecord): string => record.canonicalWorkingDirectory;
