/**
 * PERSISTENT GPU READBACKS.
 *
 * three's `copyTextureToBuffer` and `getArrayBufferAsync` mint a fresh
 * staging buffer per call and `slice()` a fresh ArrayBuffer for the result.
 * The sea's buoyancy copy is 1 MB every other frame: 30 MB/s of GPU buffers
 * created and destroyed and as much JS garbage, which a desktop absorbs and
 * a phone does not ("on mobile it starts with 60 fps, but with time drops to
 * 15–20 … until the page got crashed", user, 2026-09-07). A reader here owns
 * ONE staging buffer and ONE typed array for its whole life; a read copies
 * into them and allocates nothing.
 *
 * A read in flight makes the next read return null (the caller skips a
 * frame); the arrays a read returns are the reader's own and are overwritten
 * by the next read.
 */

const align256 = (n) => Math.ceil(n / 256) * 256;

/**
 * A texture (or texture array) reader: `read(layers)` → one typed array per layer.
 * @param {*} renderer
 * @param {*} texture
 * @param {{width:number, height:number, layers?:number, bytesPerTexel?:number,
 *   ArrayType?: Uint8ArrayConstructor|Uint16ArrayConstructor|Uint32ArrayConstructor|
 *     Int8ArrayConstructor|Int16ArrayConstructor|Int32ArrayConstructor|Float32ArrayConstructor}} options
 *   The default `ArrayType` (Uint16Array) matches the sea's half-float maps — pass the
 *   constructor matching the source texture's actual bytesPerTexel/format (e.g. Float32Array
 *   for a `FloatType` render target).
 */
export function createTextureReadback(renderer, texture, { width, height, layers = 1, bytesPerTexel = 8, ArrayType = Uint16Array }) {
  const device = renderer?.backend?.device;
  if (!device) return null;
  const bytesPerRow = align256(width * bytesPerTexel), rowBytes = width * bytesPerTexel, layerBytes = bytesPerRow * height;
  const buffer = device.createBuffer({ label: `${texture.name || 'texture'} readback`, size: layerBytes * layers, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const outputs = Array.from({ length: layers }, () => new ArrayType((rowBytes * height) / ArrayType.BYTES_PER_ELEMENT));
  // Reused result view: `outputs.slice(0, count)` allocated a fresh array every
  // read (once per texture per call site, every other frame for the sea's
  // buoyancy copy). Callers only iterate the result immediately (never retain
  // it across frames — the typed arrays inside are already the reader's own
  // and get overwritten next read), so one scratch array serves every call.
  const view = [];
  let busy = false, disposed = false;
  return {
    get busy() { return busy; },
    async read(count = layers) {
      if (busy || disposed) return null;
      const gpuTexture = renderer.backend.get(texture)?.texture;
      if (!gpuTexture) return null;
      busy = true;
      try {
        const encoder = device.createCommandEncoder({ label: 'water readback' });
        for (let layer = 0; layer < count; layer++) {
          encoder.copyTextureToBuffer({ texture: gpuTexture, mipLevel: 0, origin: { x: 0, y: 0, z: layer } },
            { buffer, offset: layer * layerBytes, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
        }
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ, 0, layerBytes * count);
        if (disposed) return null;
        const mapped = buffer.getMappedRange(0, layerBytes * count);
        for (let layer = 0; layer < count; layer++) {
          const out = outputs[layer];
          if (bytesPerRow === rowBytes) out.set(new ArrayType(mapped, layer * layerBytes, out.length));
          else for (let row = 0; row < height; row++) out.set(new ArrayType(mapped, layer * layerBytes + row * bytesPerRow, rowBytes / ArrayType.BYTES_PER_ELEMENT), row * rowBytes / ArrayType.BYTES_PER_ELEMENT);
        }
        buffer.unmap();
        view.length = count;
        for (let layer = 0; layer < count; layer++) view[layer] = outputs[layer];
        return view;
      } finally { busy = false; }
    },
    dispose() { disposed = true; if (!busy) buffer.destroy(); else buffer.mapAsync(GPUMapMode.READ).catch(() => {}).finally(() => buffer.destroy()); },
  };
}

/** A storage-buffer reader (an atomic counter, a small table): `read()` → one typed array. */
export function createBufferReadback(renderer, attribute, { byteLength, ArrayType = Uint32Array }) {
  const device = renderer?.backend?.device;
  if (!device) return null;
  const size = align256(byteLength);
  const buffer = device.createBuffer({ label: `${attribute.name || 'buffer'} readback`, size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const output = new ArrayType(byteLength / ArrayType.BYTES_PER_ELEMENT);
  let busy = false, disposed = false;
  return {
    get busy() { return busy; },
    async read() {
      if (busy || disposed) return null;
      const source = renderer.backend.get(attribute)?.buffer;
      if (!source) return null;
      busy = true;
      try {
        const encoder = device.createCommandEncoder({ label: 'water counter readback' });
        encoder.copyBufferToBuffer(source, 0, buffer, 0, byteLength);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ, 0, size);
        if (disposed) return null;
        output.set(new ArrayType(buffer.getMappedRange(0, size), 0, output.length));
        buffer.unmap();
        return output;
      } finally { busy = false; }
    },
    dispose() { disposed = true; if (!busy) buffer.destroy(); else buffer.mapAsync(GPUMapMode.READ).catch(() => {}).finally(() => buffer.destroy()); },
  };
}
