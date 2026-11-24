import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This file sits one level below the project root.
export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function warehousePath(): string {
  return process.env.WAREHOUSE_DB ?? join(PROJECT_ROOT, "data", "warehouse.db");
}

export function statePath(): string {
  return process.env.STATE_DB ?? join(PROJECT_ROOT, "data", "state.db");
}
