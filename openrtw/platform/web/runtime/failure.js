// Diagnostics must not interrupt resource cleanup. Keep ordinary text intact;
// callers retain the original cause separately when their contract exposes it.
export function describeFailure(value) {
  try { return String(value); }
  catch { return 'Unprintable failure cause'; }
}

export function failureMessage(value) {
  try { return String(value instanceof Error ? value.message : value); }
  catch { return 'Unprintable failure cause'; }
}
