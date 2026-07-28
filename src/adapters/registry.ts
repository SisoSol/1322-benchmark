import type { FeedAdapter } from "./types";
import { X1322Adapter } from "./x1322";
import { GenericAdapter } from "./generic";

const FACTORIES: Record<string, () => FeedAdapter> = {
  x1322: () => new X1322Adapter(),
  generic: () => new GenericAdapter(),
};

export const ADAPTER_IDS = Object.keys(FACTORIES);

export function createAdapter(id: string): FeedAdapter {
  const factory = FACTORIES[id];
  if (!factory) {
    throw new Error(
      `Unknown adapter "${id}". Valid values: ${ADAPTER_IDS.join(", ")}.`,
    );
  }
  return factory();
}
