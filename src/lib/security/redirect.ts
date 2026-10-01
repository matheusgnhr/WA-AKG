// Keep credential sign-in destinations inside this application.
export function safeLoginRedirect(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020]/.test(value)) return '/dashboard';
  return value;
}
