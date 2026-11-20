'use strict';

// fetch may decompress the body or receive no Content-Length at all. Count the
// actual bytes as they arrive. Leaving the loop cancels the unread stream.
async function readLimitedBody(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body ?? []) {
    length += chunk.byteLength;
    if (length > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

module.exports = {readLimitedBody};
