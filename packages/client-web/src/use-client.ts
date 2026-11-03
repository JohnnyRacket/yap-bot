import { useSyncExternalStore } from "react";
import { client, type Snapshot } from "./client.ts";

/** The client's state; re-renders whenever it changes. */
export function useClient(): Snapshot {
  return useSyncExternalStore(client.subscribe, client.getSnapshot);
}
