export function recordId(timestamp) {
  return `${timestamp}-${crypto.randomUUID()}`;
}

export async function readCollection(kv, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...page.keys.map(key => key.name));
    if (page.list_complete) break;
    cursor = page.cursor;
  } while (cursor);

  const records = [];
  async function readBatch(batch) {
    try {
      const values = await kv.get(batch, 'json');
      return batch.map(key => values.get(key)).filter(Boolean);
    } catch {
      // Bulk responses have a 25 MB cap, even when each value is valid on its own.
      if (batch.length === 1) {
        const value = await kv.get(batch[0], 'json');
        return value ? [value] : [];
      }
      const middle = Math.ceil(batch.length / 2);
      return [...await readBatch(batch.slice(0, middle)), ...await readBatch(batch.slice(middle))];
    }
  }
  // Bulk reads avoid one KV subrequest per record.
  for (let start = 0; start < keys.length; start += 100) {
    const batch = keys.slice(start, start + 100);
    records.push(...await readBatch(batch));
  }
  return records;
}
