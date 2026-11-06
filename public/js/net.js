export async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Office': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export function connect(onMessage, onStatus) {
  let ws;
  let retry = 500;
  const open = () => {
    ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onopen = () => { retry = 500; onStatus(true); };
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = () => { onStatus(false); setTimeout(open, retry); retry = Math.min(8000, retry * 1.6); };
  };
  open();
}
