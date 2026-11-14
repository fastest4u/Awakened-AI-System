export function statusBadgeVariant(
  status: string,
): 'success' | 'warning' | 'destructive' | 'secondary' {
  const s = status.toLowerCase().trim();
  if (s === 'verified' || s === 'active') {
    return 'success';
  }
  if (s === 'candidate' || s === 'provisional') {
    return 'warning';
  }
  if (
    s === 'conflicted' ||
    s === 'expired' ||
    s === 'superseded' ||
    s === 'retracted'
  ) {
    return 'destructive';
  }
  return 'secondary';
}
