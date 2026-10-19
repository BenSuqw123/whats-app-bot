'use strict';
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

// rc13's download helper drops AbortSignal and uses pipe without forwarding input
// errors. Reuse Baileys' protocol/key helpers with an abortable native transport.
async function openMediaStream(info, type, { signal, maxBytes }, baileys = require('@whiskeysockets/baileys')) {
  signal.throwIfAborted();
  const url = info.directPath
    ? baileys.getUrlFromDirectPath(info.directPath, info.url ? new URL(info.url).host : undefined)
    : info.url;
  if (!url) throw new Error('Missing media URL');
  const { cipherKey, iv, macKey } = await baileys.getMediaKeys(info.mediaKey, type);
  signal.throwIfAborted();
  const response = await fetch(url, { signal, headers: { Origin: 'https://web.whatsapp.com' } });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error(`Media HTTP status ${response.status}`), { code: 'MEDIA_HTTP_ERROR' });
  }
  const encryptedLength = Number(response.headers.get('content-length'));
  // Ciphertext adds PKCS7 padding (<=16) and a ten-byte MAC; never buffer oversized bodies.
  if (encryptedLength > maxBytes + 26) {
    await response.body?.cancel();
    throw Object.assign(new Error('Encrypted media exceeds size limit'), { code: 'MEDIA_OVERSIZED' });
  }
  const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
  const hmac = crypto.createHmac('sha256', macKey).update(iv);
  const hash = crypto.createHash('sha256');
  let tail = Buffer.alloc(0), size = 0;
  function plaintext(chunk, output) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Media exceeds size limit'), { code: 'MEDIA_OVERSIZED' });
    hash.update(chunk); output.push(chunk);
  }
  const decrypted = new Transform({
    transform(chunk, encoding, callback) {
      try {
        const data = Buffer.concat([tail, chunk]);
        const count = Math.max(0, data.length - 10);
        const ciphertext = data.subarray(0, count);
        tail = Buffer.from(data.subarray(count)); // Retain only the trailing MAC, not a whole chunk.
        if (ciphertext.length) { hmac.update(ciphertext); plaintext(decipher.update(ciphertext), this); }
        callback();
      } catch (error) { callback(error); }
    },
    flush(callback) {
      try {
        if (tail.length !== 10 || !crypto.timingSafeEqual(hmac.digest().subarray(0, 10), tail)) {
          throw Object.assign(new Error('Media integrity check failed'), { code: 'MEDIA_INTEGRITY' });
        }
        plaintext(decipher.final(), this);
        const digest = hash.digest();
        if (info.fileSha256 && !digest.equals(Buffer.from(info.fileSha256))) {
          throw Object.assign(new Error('Media plaintext hash mismatch'), { code: 'MEDIA_INTEGRITY' });
        }
        callback();
      } catch (error) { callback(error); }
    },
  });
  decrypted.on('error', () => {});
  // pipeline subscribes to errors on both the transport and decryptor and destroys
  // both on abort. A consumer receives the error; no unhandled upstream 'error'.
  pipeline(Readable.fromWeb(response.body), decrypted, { signal }).catch(error => decrypted.destroy(error));
  return decrypted;
}
module.exports = { openMediaStream };
