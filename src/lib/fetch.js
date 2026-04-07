const DEFAULT_HEADERS = {
  "user-agent": "KazanEventRadar/0.1 (+local bot; contact owner)",
  accept: "text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8"
};

export async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...DEFAULT_HEADERS,
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response.text();
}
