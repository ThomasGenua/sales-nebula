// Provider attachment responses carry base64 payloads. Bound the stream before
// JSON parsing, rather than buffering an arbitrary response and checking later.
module.exports = async function boundedJson(response, maxBytes) {
  if (Number(response.headers?.get?.('content-length')) > maxBytes) { await response.body?.cancel?.(); throw Object.assign(new Error('Provider response exceeds the download limit'), { status: 413 }); }
  if (!response.body) return response.json();
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Provider response exceeds the download limit'), { status: 413 });
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};
