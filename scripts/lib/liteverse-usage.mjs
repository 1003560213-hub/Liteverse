// Keep the model-independent CLI usable from all three supported layouts:
// project source, ~/.codex installation, and the packaged App Resources tree.
const candidates = [
  new URL("../../skills/liteverse-retriever/scripts/_usage-ledger.mjs", import.meta.url),
  new URL("../../CodexSkills/liteverse-retriever/scripts/_usage-ledger.mjs", import.meta.url),
];

async function loadUsageRuntime() {
  const errors = [];
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
      errors.push(candidate.pathname);
    }
  }
  throw new Error(`Liteverse usage runtime was not found in: ${errors.join(", ")}`);
}

const runtime = await loadUsageRuntime();

export const hashTask = runtime.hashTask;
export const readLedger = runtime.readLedger;
export const rebuildCounts = runtime.rebuildCounts;
export const recordUsage = runtime.recordUsage;
export const summarizeEvents = runtime.summarizeEvents;
export const withUsageLock = runtime.withUsageLock;
