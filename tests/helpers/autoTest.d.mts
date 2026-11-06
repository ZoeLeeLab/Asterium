export interface AutoTestRun { version: number; root: string; systemTemp: string; token: string; pid: number; createdAt: string; }
export interface AutoTestWorker { run: AutoTestRun; worker: string; evidence: string; failed: boolean; }
export function createAutoTestRun(): AutoTestRun;
export function beginAutoTestWorker(run: AutoTestRun, label?: string, vitest?: boolean): AutoTestWorker;
export function beginAutoTestCase(): string;
export function endAutoTestCase(): void;
export function setAutoTestFailureProbe(probe: () => boolean): void;
export function markAutoTestFailure(reason?: string): void;
export function finishAutoTestWorker(): Promise<void>;
export function cleanupAutoTestRun(run: AutoTestRun, options?: { allowFailed?: boolean }): boolean;
export const testRm: typeof import('node:fs/promises').rm;
export const testRmSync: typeof import('node:fs').rmSync;
export function autoTestEvidence(label?: string, requested?: string): string;
export function autoTestOutput(requested?: string): string;
