export interface ComputationRecord {
  id: string; jobId: string; stepId: string; skillId: string; entrypoint: string; catalogVersion: string;
  implementationKind: string; sourceRevision: string; provider: string;
  environment: { node: string; platform: string; arch: string };
  parameters: Record<string, unknown>; seed: number | null;
  inputs: Array<{ path: string; sha256: string }>;
  outputs: Array<{ path: string; kind: string; mimeType: string; sha256: string; bytes: number }>;
  exitStatus: "complete" | "failed"; durationMs: number; costUsd: number;
  deterministicRerun: "not-checked" | "exact-rerun-verified";
  codeSha256?: string;
  inputSetSha256?: string;
  outputSetSha256?: string;
  executionReceiptSha256?: string;
  piSessionId?: string; approvedSkills?: string[]; activatedSkills?: string[]; executionReceipts?: unknown[]; error?: string;
}

export function verifyExactRerun(previous: ComputationRecord, current: ComputationRecord): boolean {
  const a = (previous.executionReceipts || []) as any[]; const b = (current.executionReceipts || []) as any[];
  if (!a.length || a.length !== b.length || previous.skillId !== current.skillId || previous.entrypoint !== current.entrypoint) return false;
  return a.every((receipt, index) => {
    const other = b[index];
    return receipt.determinism === "deterministic" && other?.determinism === "deterministic"
      && receipt.environment?.lockHash === other.environment?.lockHash
      && (!previous.codeSha256 || !current.codeSha256 || previous.codeSha256 === current.codeSha256)
      && JSON.stringify(receipt.inputs?.map((item: any) => item.sha256)) === JSON.stringify(other.inputs?.map((item: any) => item.sha256))
      && JSON.stringify(receipt.outputs?.map((item: any) => item.sha256)) === JSON.stringify(other.outputs?.map((item: any) => item.sha256));
  });
}
