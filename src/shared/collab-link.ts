/** Base64url helpers adapted from oh-my-pi collab-web/src/lib/link.ts (MIT).
 * See docs/third-party/oh-my-pi-LICENSE. Our links use the Paper2Experiment protocol.
 */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const base64 = text.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.length % 4 === 0 ? base64 : base64 + '='.repeat(4 - base64.length % 4);
  try {
    return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
  } catch { return null; }
}

export function parseCollabToken(value: string): string | null {
  let token = value.trim();
  if (token.includes('://')) {
    try { token = new URL(token).hash; } catch { return null; }
  }
  token = token.replace(/^#p2e=/, '');
  const bytes = decodeBase64Url(token);
  return bytes?.length === 32 && encodeBase64Url(bytes) === token ? token : null;
}

export function collabLink(origin: string, token: string): string {
  if (!parseCollabToken(token)) throw new Error('Некорректный ключ подключения');
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Нужен HTTP(S) origin');
  url.hash = `p2e=${token}`;
  return url.href;
}
