/**
 * Where cost records are read and appended (§19.3).
 *
 * Extracted from `agent-execution.ts` because synthesis needs the same port: the #160 ruling
 * requires the synthesis gateway to write Runtime-attributed cost records too, and a second copy
 * of this interface would be two definitions of where money is recorded.
 */

import type { CostRecord } from "@aldus-runtime/core";

export interface CostRecordStore {
  list(runId: string): Promise<CostRecord[]>;
  append(runId: string, record: CostRecord): Promise<void>;
}
