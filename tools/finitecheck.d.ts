/**
 * Types for tools/finitecheck.mjs, so TypeScript CPU entries can import the
 * shared check rather than each keeping a private copy of it.
 */
export declare class FiniteProblem {
  where: string;
  kind: string;
  index: number;
  value: unknown;
  detail: string;
  toString(): string;
}

export interface FiniteCheckOptions {
  /** Stop after this many problems. Default 20. */
  limit?: number;
}

export declare function checkGeometry(geometry: unknown, where?: string, opts?: FiniteCheckOptions): FiniteProblem[];
export declare function checkCards(cards: unknown, where?: string, opts?: FiniteCheckOptions): FiniteProblem[];
export declare function checkMesh(mesh: unknown, where?: string, opts?: FiniteCheckOptions): FiniteProblem[];
export declare function checkObject(root: unknown, where?: string, opts?: FiniteCheckOptions): FiniteProblem[];
export declare function check(subject: unknown, where?: string, opts?: FiniteCheckOptions): FiniteProblem[];

/** Throws if any non-finite value is present. The form to call in a smoke test. */
export declare function assertFinite(subject: unknown, where?: string, opts?: FiniteCheckOptions): void;
