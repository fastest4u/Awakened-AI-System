export function isImeComposing(e: {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}): boolean {
  if (e.isComposing === true || e.keyCode === 229) {
    return true;
  }
  if (
    e.nativeEvent &&
    (e.nativeEvent.isComposing === true || e.nativeEvent.keyCode === 229)
  ) {
    return true;
  }
  return false;
}

export function isEditableTarget(el: Element | null): boolean {
  if (!el) return false;
  const tagName = el.tagName;
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
    return true;
  }
  if (
    (el as HTMLElement).isContentEditable ||
    el.getAttribute('contenteditable') === 'true'
  ) {
    return true;
  }
  if (el.closest('input, textarea, select, [contenteditable="true"]')) {
    return true;
  }
  return false;
}
