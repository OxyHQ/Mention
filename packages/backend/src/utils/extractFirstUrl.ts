/** Extract the first http(s)/www URL from post text (composer + hydration parity). */
export function extractFirstUrl(text: string): string | null {
  if (!text) return null;
  const urlPattern = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(text)) !== null) {
    if (!match[0]) continue;
    let url = match[0];
    while (/[.,!?):;\]]$/.test(url)) {
      url = url.slice(0, -1);
    }
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }
    try {
      new URL(url);
      return url;
    } catch {
      continue;
    }
  }
  return null;
}
