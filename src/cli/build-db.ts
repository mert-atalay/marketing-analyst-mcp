import { warehousePath } from "../paths.ts";
import { buildWarehouse, DATA_END, DATA_START, SEED } from "../seed.ts";

const summary = buildWarehouse(warehousePath());
console.log(`Built synthetic warehouse at ${summary.path}`);
console.log(`Seed ${SEED}, dates ${DATA_START} to ${DATA_END}`);
console.log(
  `${summary.locations} locations, ${summary.campaigns} campaigns, ${summary.spendRows} spend rows, ${summary.leads} leads`,
);
