const UA = "hireloop/0.1 (+https://github.com/hireloop/hireloop; personal job search tool)";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export async function http(url: string, init: RequestInit & { timeoutMs?: number; browser?: boolean } = {}): Promise<Response> {
  const { timeoutMs = 20000, browser, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", browser ? BROWSER_UA : UA);
  const res = await fetch(url, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  return res;
}

export async function getJson<T = any>(url: string, init: Parameters<typeof http>[1] = {}): Promise<T> {
  const res = await http(url, { ...init, headers: { accept: "application/json", ...(init.headers as Record<string, string>) } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return (await res.json()) as T;
}

export async function getText(url: string, init: Parameters<typeof http>[1] = {}): Promise<string> {
  const res = await http(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return await res.text();
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(br|p|li|div|h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
}
