// Raw-deflate helper shared by the ZIP writer.
export async function deflateBytes(bytes) {
  if (typeof CompressionStream !== 'undefined') {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { deflateRawSync } = await import('node:zlib');
  return deflateRawSync(bytes);
}
