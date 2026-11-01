// Deliberate: needs a person (a guard, a conflict, a stuck review). Any other thrown error is transient and retried on its own.
export class Deliberate extends Error {}
// A transient failure raised on purpose, e.g. a Claude run that returned ok:false.
export class Transient extends Error {}
export const isDeliberate = (e: unknown): boolean => e instanceof Deliberate;
