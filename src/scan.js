import "dotenv/config";
import { scanSources } from "./aggregator.js";

const items = await scanSources();
console.log(`Scan finished. Stored items: ${items.length}`);
