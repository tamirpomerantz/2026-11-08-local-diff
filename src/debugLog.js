export function kleinLog(source, message, data) {
  console.debug("klein", source, message, data ?? "");
  fetch("/api/debug-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, message, data: data ?? null, at: Date.now() }),
  }).catch(() => {});
}

export function nodeIds(nodes) {
  return (nodes ?? []).map((node) => node.id);
}
