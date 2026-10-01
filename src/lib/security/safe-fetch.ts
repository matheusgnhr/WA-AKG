import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export function isPublicAddress(address: string): boolean {
  try {
    const ip = ipaddr.process(address);
    return ip.range() === 'unicast';
  } catch { return false; }
}

async function boundedLookup(host: string, signal?: AbortSignal | null) {
  if (signal?.aborted) throw new Error('Request aborted');
  let timer: ReturnType<typeof setTimeout>;
  let abort: () => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS resolution timeout')), 5_000);
    abort = () => reject(new Error('Request aborted'));
    signal?.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([lookup(host, { all: true, verbatim: true }), deadline]); }
  finally { clearTimeout(timer!); signal?.removeEventListener('abort', abort); }
}

export function validateSafeUrl(input: string, webhook = false): URL {
  const url = new URL(input);
  const allowed = webhook && (process.env.WEBHOOK_ALLOWED_ORIGINS || '').split(',').filter(Boolean).includes(url.origin);
  if ((url.protocol !== 'https:' && !(allowed && url.protocol === 'http:')) || url.username || url.password || url.hash) {
    throw new Error('Only HTTPS URLs without credentials/fragments are allowed');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host.toLowerCase() === 'metadata.google.internal' || host === '169.254.169.254') throw new Error('Forbidden destination');
  if (isIP(host) && !isPublicAddress(host) && !allowed) throw new Error('Private destination blocked');
  return url;
}

// DNS results are checked and the selected IP is pinned to the socket lookup. No redirects or pool reuse.
export async function safeFetch(input: string, init: RequestInit = {}, webhook = false): Promise<Response> {
  if (init.signal?.aborted) throw new Error('Request aborted');
  const url = validateSafeUrl(input, webhook);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const privateAllowed = webhook && (process.env.WEBHOOK_ALLOWED_ORIGINS || '').split(',').filter(Boolean).includes(url.origin);
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await boundedLookup(host, init.signal);
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address) && !privateAllowed)) throw new Error('Private DNS destination blocked');
  // Even an explicit private webhook allowlist never grants access to link-local metadata.
  if (addresses.some(a => ipaddr.process(a.address).range() === 'linkLocal')) throw new Error('Link-local destination blocked');
  const selected = addresses[0];
  const maxBytes = webhook ? 64 * 1024 : 10 * 1024 * 1024;
  let body: string | Uint8Array | undefined;
  const requestHeaders = new Headers(init.headers);
  if (init.body instanceof FormData) {
    // Request serializes multipart locally; it performs no network operation.
    const serialized = new Request(url, { method: init.method || 'POST', headers: requestHeaders, body: init.body });
    body = new Uint8Array(await serialized.arrayBuffer());
    requestHeaders.set('content-type', serialized.headers.get('content-type')!);
  } else if (typeof init.body === 'string') body = init.body;
  else if (init.body) throw new Error('Unsupported request body');
  if (body && Buffer.byteLength(body) > 11 * 1024 * 1024) throw new Error('Request exceeds size limit');
  const headers = Object.fromEntries(requestHeaders.entries());
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const resolve = (value: Response) => { settled = true; resolvePromise(value); };
    const reject = (error: unknown) => { settled = true; rejectPromise(error); };
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, 10_000);
    init.signal?.addEventListener('abort', abort, { once: true });
    if (init.signal?.aborted) abort();
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: init.method || 'GET', headers, agent: false, signal: controller.signal,
      family: selected.family,
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
    }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) req.destroy(new Error('Response exceeds size limit'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
        const status = res.statusCode || 502;
        if (status >= 300 && status < 400) { reject(new Error('Redirects are forbidden')); return; }
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) if (value) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
        resolve(new Response([204, 205, 304].includes(status) ? null : new Uint8Array(Buffer.concat(chunks)), { status, headers: responseHeaders }));
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.on('upgrade', (_response, socket) => { socket.destroy(); reject(new Error('Protocol upgrades are forbidden')); });
    req.on('connect', (_response, socket) => { socket.destroy(); reject(new Error('Protocol tunnels are forbidden')); });
    req.on('close', () => { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); if (!settled) reject(new Error('Response closed before completion')); });
    req.end(body);
  });
}
