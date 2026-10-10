/** Requête JSON tolérante : une source indisponible ne doit jamais faire échouer la recherche. */
export async function fetchJson<T>(
  url: string,
  init: { headers?: Record<string, string>; timeoutMs?: number; label?: string } = {},
): Promise<T | null> {
  const { headers = {}, timeoutMs = 8000, label = 'http' } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[${label}] HTTP ${res.status} sur ${url}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[${label}] injoignable : ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') sp.set(key, String(value));
  }
  return sp.toString();
}
