import { layerStore, getLayerForCreator } from "../geometry/layers";
import { levelStore, getActiveLevelId } from "../geometry/levels";

export function resolveLayerId(creator: string, args: Record<string, unknown>): string {
  const explicit = args.layer as string | undefined;
  if (explicit && layerStore.get(explicit)) return explicit;
  return getLayerForCreator(creator);
}

export function getActiveLevelElevation(): number {
  return levelStore.get(getActiveLevelId())?.elevation ?? 0;
}
