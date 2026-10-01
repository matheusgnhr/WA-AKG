/** Normalize thrown values without assuming providers always throw Error instances. */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object' && 'message' in value && typeof value.message === 'string') return value.message;
  return 'Operation failed';
}
