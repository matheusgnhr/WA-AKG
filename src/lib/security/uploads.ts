export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Bound streamed/chunked requests too; Content-Length alone is not a limit.
export async function boundedFormData(request: Request): Promise<FormData> {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_UPLOAD_BYTES || declared < 0) throw new Error('Upload exceeds 10 MiB');
  if (!request.body) throw new Error('Upload body is required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPLOAD_BYTES) { await reader.cancel(); throw new Error('Upload exceeds 10 MiB'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new Response(new Uint8Array(Buffer.concat(chunks)), { headers: { 'content-type': request.headers.get('content-type') || '' } }).formData();
}
