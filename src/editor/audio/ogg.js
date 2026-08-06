/**
 * An Ogg bitstream muxer, hand-written, plus the two Opus header packets.
 *
 * ## Why this exists
 *
 * Everything the Audio Library imports from Freesound arrives as `.ogg`, and
 * until this file existed the editor could *read* those and never write them —
 * editing one saved a sibling `.wav` and said so. That is a rough edge on the
 * most common file in a project. It also meant every exported build shipped
 * uncompressed audio, which is usually the largest thing in a web build.
 *
 * The encoder itself is not here. `AudioEncoder` (WebCodecs) produces Opus
 * *packets*; nothing in the browser will wrap them in an Ogg container, which is
 * the format `decodeAudioData`, every browser, and every game engine actually
 * reads. So the codec stays at the edge (`encodeOpus.js`, the third and last
 * place Web APIs appear in this directory, beside `decode.js` and `playback.js`)
 * and the container is written here, in plain JS, where `npm run test:audio` can
 * exercise it against synthetic packets under node.
 *
 * ## The format, only the parts that bite
 *
 * A page is a 27-byte header, a segment table, then the payload. Three details
 * are where a hand-written muxer goes wrong:
 *
 *  - **Lacing.** A packet is split into 255-byte segments; the last one is
 *    shorter. A packet whose length is an exact multiple of 255 therefore needs
 *    a trailing zero-length segment, or the demuxer reads it as continuing into
 *    the next packet. This is the single most common Ogg bug and it only shows
 *    up on packets of exactly 255, 510, … bytes.
 *  - **The CRC is not the usual CRC-32.** Same polynomial, but no input/output
 *    reflection and no final XOR — `zlib.crc32` gives a different answer, and a
 *    wrong CRC makes a file that looks structurally perfect and plays as
 *    nothing.
 *  - **The granule position is Opus-specific.** It counts 48 kHz samples
 *    *including* pre-skip regardless of the input rate, it belongs to the last
 *    packet that FINISHES on the page (−1 if none does), and the final page's
 *    value is what trims the encoder's padding off the end. Get it wrong and
 *    the file plays with a fraction of a second of silence or garbage at one
 *    end — the classic "my loop has a gap now" bug.
 */

/**
 * Ogg's CRC-32: polynomial 0x04c11db7, initial value 0, **not** reflected and
 * with no final XOR. Deliberately built once at module load — a 256-entry table
 * is 1 KB and rebuilding it per page would dominate the cost of muxing.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let bit = 0; bit < 8; bit++) r = (r & 0x80000000) !== 0 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

export function oggCrc32(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) & 0xff) ^ bytes[i]]) >>> 0;
  }
  return crc >>> 0;
}

/** How many lacing segments a packet of `length` bytes occupies. */
export const segmentsFor = (length) => Math.floor(length / 255) + 1;

const HEADER_CONTINUED = 0x01;
const HEADER_BOS = 0x02;
const HEADER_EOS = 0x04;

const MAX_SEGMENTS = 255;
/**
 * Target payload before a page is closed. Nothing in the spec requires this —
 * pages may be up to 64 KB — but small pages keep seeking cheap and match what
 * every other Opus muxer produces, which is the behaviour players are tested
 * against.
 */
const TARGET_PAGE_BYTES = 4000;

function writePage({ serial, sequence, granulePosition, headerType, segmentSizes, payloadLength, payloadChunks }) {
  const page = new Uint8Array(27 + segmentSizes.length + payloadLength);
  const view = new DataView(page.buffer);

  page[0] = 0x4f; // O
  page[1] = 0x67; // g
  page[2] = 0x67; // g
  page[3] = 0x53; // S
  page[4] = 0; // stream structure version
  page[5] = headerType;
  // 64-bit and signed: −1 ("no packet completes here") must come out as all
  // ones, and a long enough file passes 2^32 samples, so BigInt rather than a
  // two-word hand-rolled write.
  view.setBigInt64(6, BigInt(granulePosition), true);
  view.setUint32(14, serial >>> 0, true);
  view.setUint32(18, sequence >>> 0, true);
  view.setUint32(22, 0, true); // CRC is computed over the page with this field zeroed
  page[26] = segmentSizes.length;
  page.set(segmentSizes, 27);

  let offset = 27 + segmentSizes.length;
  for (const chunk of payloadChunks) {
    page.set(chunk, offset);
    offset += chunk.length;
  }

  view.setUint32(22, oggCrc32(page), true);
  return page;
}

/**
 * Packs packets into pages.
 *
 * `packets` are `{ data, granule }` where `granule` is the stream position
 * *after* that packet has been decoded. A packet larger than one page's worth
 * of segments (64 KB) is split, and the continuation page carries the continued
 * flag with granule −1 — Opus packets never get near that, but a muxer that
 * silently corrupts one that does is worse than one that handles it.
 *
 * Returns `{ pages, nextSequence }` so header pages and audio pages can be
 * built by separate calls and still share one numbering.
 */
export function packOggPages({
  serial,
  packets,
  startSequence = 0,
  bos = false,
  eos = false,
  pageBytes = TARGET_PAGE_BYTES,
  emptyGranule = 0,
}) {
  const pages = [];
  let sequence = startSequence;
  let bosPending = bos;

  let segmentSizes = [];
  let payloadChunks = [];
  let payloadLength = 0;
  let pageGranule = -1;
  let continued = false;
  let midPacket = false;

  const flush = (isLast) => {
    pages.push(
      writePage({
        serial,
        sequence,
        granulePosition: pageGranule,
        headerType: (continued ? HEADER_CONTINUED : 0) | (bosPending ? HEADER_BOS : 0) | (isLast ? HEADER_EOS : 0),
        segmentSizes: Uint8Array.from(segmentSizes),
        payloadLength,
        payloadChunks,
      }),
    );
    sequence++;
    bosPending = false;
    // The page that follows a page closed mid-packet starts with the rest of
    // that packet, which is exactly what the continued flag means.
    continued = midPacket;
    segmentSizes = [];
    payloadChunks = [];
    payloadLength = 0;
    pageGranule = -1;
  };

  for (let index = 0; index < packets.length; index++) {
    const packet = packets[index];
    const data = packet.data;
    let offset = 0;
    let remaining = segmentsFor(data.length);
    midPacket = true;

    while (remaining > 0) {
      if (segmentSizes.length >= MAX_SEGMENTS) flush(false);
      const take = Math.min(MAX_SEGMENTS - segmentSizes.length, remaining);
      for (let i = 0; i < take; i++) {
        // The last segment of a packet is < 255 by definition — including the
        // zero-length one an exact multiple of 255 requires.
        const size = Math.min(255, data.length - offset);
        segmentSizes.push(size);
        if (size > 0) {
          payloadChunks.push(data.subarray(offset, offset + size));
          payloadLength += size;
        }
        offset += size;
      }
      remaining -= take;
    }

    midPacket = false;
    // A page's granule belongs to the last packet that completes on it.
    pageGranule = packet.granule;
    // Never auto-flush the last packet. The end-of-stream page is what carries
    // the stream's total length, and a stream whose final packet happened to
    // land on a page boundary would otherwise end with an empty EOS page
    // reporting granule −1 — a file every decoder reads as zero-length.
    const isLastPacket = index === packets.length - 1;
    if (!isLastPacket && (payloadLength >= pageBytes || segmentSizes.length >= MAX_SEGMENTS)) flush(false);
  }

  if (eos && segmentSizes.length === 0) pageGranule = emptyGranule;
  if (eos || segmentSizes.length > 0) flush(!!eos);
  return { pages, nextSequence: sequence };
}

/** The `OpusHead` identification packet (mapping family 0: mono or stereo). */
export function opusHead({ channels = 2, preSkip = 312, inputSampleRate = 48000, outputGain = 0 } = {}) {
  if (channels < 1 || channels > 2) {
    throw new Error(`Ogg Opus mapping family 0 covers mono and stereo; got ${channels} channels.`);
  }
  const bytes = new Uint8Array(19);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
  bytes[8] = 1; // version
  bytes[9] = channels;
  view.setUint16(10, preSkip, true);
  // Informational only — the stream is always 48 kHz. Players show it, and a
  // resampler that wants to undo our upsample can read it.
  view.setUint32(12, inputSampleRate, true);
  view.setInt16(16, outputGain, true);
  bytes[18] = 0; // channel mapping family
  return bytes;
}

/** The `OpusTags` comment packet. */
export function opusTags(vendor = "engine-audio-editor", comments = []) {
  const encoder = new TextEncoder();
  const vendorBytes = encoder.encode(vendor);
  const commentBytes = comments.map((c) => encoder.encode(c));
  const length = 8 + 4 + vendorBytes.length + 4 + commentBytes.reduce((sum, c) => sum + 4 + c.length, 0);
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0); // "OpusTags"
  view.setUint32(8, vendorBytes.length, true);
  bytes.set(vendorBytes, 12);
  let offset = 12 + vendorBytes.length;
  view.setUint32(offset, commentBytes.length, true);
  offset += 4;
  for (const comment of commentBytes) {
    view.setUint32(offset, comment.length, true);
    bytes.set(comment, offset + 4);
    offset += 4 + comment.length;
  }
  return bytes;
}

/**
 * Opus packets → a complete `.ogg` file.
 *
 * `packets` are `{ data, frames }`, `frames` being the packet's duration in
 * 48 kHz samples (960 for the usual 20 ms frame).
 *
 * `finalGranule` is how the last fraction of a frame gets trimmed. Opus encodes
 * in whole frames, so a 1.005 s sound comes back as 1.02 s of packets; setting
 * the last page's granule to `preSkip + realFrames` tells the decoder to stop
 * early. Omit it and the padding is kept — audible on a loop as a gap, which is
 * exactly the artefact the loop maker exists to remove.
 */
export function muxOpusOgg({
  packets,
  channels = 2,
  preSkip = 312,
  inputSampleRate = 48000,
  serial = 0x4f707573,
  vendor = "engine-audio-editor",
  comments = [],
  finalGranule = null,
}) {
  const head = packOggPages({
    serial,
    packets: [{ data: opusHead({ channels, preSkip, inputSampleRate }), granule: 0 }],
    startSequence: 0,
    bos: true,
  });
  // OpusHead must be alone on the first page and OpusTags must begin a new one,
  // so these are two calls rather than one — a demuxer is entitled to reject a
  // stream that packs them together.
  const tags = packOggPages({
    serial,
    packets: [{ data: opusTags(vendor, comments), granule: 0 }],
    startSequence: head.nextSequence,
  });

  let granule = preSkip;
  const audio = packets.map((packet) => {
    granule += packet.frames;
    return { data: packet.data, granule };
  });
  if (finalGranule != null && audio.length) {
    // Cap EVERY packet at the trim point rather than rewriting only the last
    // one.
    //
    // Rewriting just the last packet needs a floor to keep granules
    // non-decreasing, and the obvious floor — the previous packet's granule —
    // silently defeats the whole thing whenever the encoder's final packet
    // advances the stream by nothing. Chromium's does exactly that: its last
    // chunk reports zero duration, so the last two packets share a granule,
    // the floor equals the untrimmed value, and the trim can never apply. That
    // is 20 ms of silence on the end of every exported sound, which is a gap at
    // the wrap of every loop.
    //
    // Capping is monotonic by construction and needs no floor: packets before
    // the trim point keep their real positions, and everything at or past it
    // reports the end of the stream — which is what the end of the stream is.
    const cap = Math.max(preSkip, Math.min(granule, Math.round(finalGranule)));
    for (const packet of audio) packet.granule = Math.min(packet.granule, cap);
  }

  const body = packOggPages({
    serial,
    packets: audio,
    startSequence: tags.nextSequence,
    eos: true,
    emptyGranule: preSkip,
  });
  const pages = [...head.pages, ...tags.pages, ...body.pages];

  const total = pages.reduce((sum, page) => sum + page.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const page of pages) {
    out.set(page, offset);
    offset += page.length;
  }
  return out;
}

/** Cheap sniff, matching `looksLikeWav`'s role in `wav.js`. */
export function looksLikeOgg(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return u8.length >= 4 && u8[0] === 0x4f && u8[1] === 0x67 && u8[2] === 0x67 && u8[3] === 0x53;
}

/**
 * A cheap read of an Ogg **Opus** stream's header and true length.
 *
 * Exists because `decodeAudioData` applies a stream's pre-skip but does **not**
 * apply its end-trim: a file whose final granule says "stop at 48000 samples"
 * decodes to the full 48960 the packets contain, with the difference showing up
 * as up to 20 ms of trailing silence. The container is right — the decoder is
 * being permissive — but the editor *re-opens* the files it writes, so without
 * this an Ogg would grow by up to a frame of silence on every save-and-reopen
 * cycle, and a loop would gain a gap it did not have before.
 *
 * Deliberately not `parseOggPages`: that walks and CRCs every page, which on a
 * 20 MB ambience is a whole extra pass to read two numbers. This reads the
 * first page and scans backwards for the last one.
 *
 * Returns `null` for anything that is not Ogg Opus — a Vorbis `.ogg` from a
 * sound library counts granules differently and must be left alone.
 */
export function opusStreamInfo(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!looksLikeOgg(u8) || u8.length < 64) return null;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  const body = 27 + u8[26];
  if (body + 19 > u8.length) return null;
  for (let i = 0; i < 8; i++) {
    if (u8[body + i] !== "OpusHead".charCodeAt(i)) return null;
  }

  const serial = view.getUint32(14, true);
  const channels = u8[body + 9];
  const preSkip = view.getUint16(body + 10, true);
  const inputSampleRate = view.getUint32(body + 12, true);

  // Backwards for the last page. The serial check keeps a byte sequence that
  // merely looks like a capture pattern inside packet data from being mistaken
  // for a page header.
  for (let i = u8.length - 27; i >= 0; i--) {
    if (u8[i] !== 0x4f || u8[i + 1] !== 0x67 || u8[i + 2] !== 0x67 || u8[i + 3] !== 0x53) continue;
    if (u8[i + 4] !== 0 || view.getUint32(i + 14, true) !== serial) continue;
    const granule = Number(view.getBigInt64(i + 6, true));
    if (granule < preSkip) return null;
    // Granules are always at 48 kHz for Opus, whatever the original rate was.
    return { channels, preSkip, inputSampleRate, frames: granule - preSkip, serial };
  }
  return null;
}

/**
 * Walks an Ogg file back into pages and packets.
 *
 * Not needed to *write* a file — it exists so the test suite can prove the
 * muxer round-trips under node, which is the only way to check the lacing and
 * CRC rules above without a browser. Reassembly across continued pages is
 * included because that is precisely the path a hand-written muxer gets wrong.
 */
export function parseOggPages(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const pages = [];
  let offset = 0;

  while (offset + 27 <= u8.length) {
    if (u8[offset] !== 0x4f || u8[offset + 1] !== 0x67 || u8[offset + 2] !== 0x67 || u8[offset + 3] !== 0x53) {
      throw new Error(`Not an Ogg page at byte ${offset}`);
    }
    const headerType = u8[offset + 5];
    const granulePosition = view.getBigInt64(offset + 6, true);
    const serial = view.getUint32(offset + 14, true);
    const sequence = view.getUint32(offset + 18, true);
    const storedCrc = view.getUint32(offset + 22, true);
    const segmentCount = u8[offset + 26];
    const segmentSizes = u8.subarray(offset + 27, offset + 27 + segmentCount);
    const payloadLength = segmentSizes.reduce((sum, size) => sum + size, 0);
    const pageLength = 27 + segmentCount + payloadLength;
    const page = u8.subarray(offset, offset + pageLength);

    // Recompute over a copy with the CRC field zeroed — the same rule the
    // writer follows, and the check that catches a header field written at the
    // wrong offset.
    const zeroed = page.slice();
    new DataView(zeroed.buffer).setUint32(22, 0, true);
    const crcOk = oggCrc32(zeroed) === storedCrc;

    pages.push({
      sequence,
      serial,
      granulePosition: Number(granulePosition),
      continued: (headerType & HEADER_CONTINUED) !== 0,
      bos: (headerType & HEADER_BOS) !== 0,
      eos: (headerType & HEADER_EOS) !== 0,
      crcOk,
      segmentSizes: Array.from(segmentSizes),
      payload: page.subarray(27 + segmentCount),
    });
    offset += pageLength;
  }

  // Packets are reassembled by the lacing rule: a segment of exactly 255 bytes
  // means "more of this packet follows", anything else ends it.
  const packets = [];
  let pending = [];
  for (const page of pages) {
    let position = 0;
    for (const size of page.segmentSizes) {
      pending.push(page.payload.subarray(position, position + size));
      position += size;
      if (size < 255) {
        const length = pending.reduce((sum, part) => sum + part.length, 0);
        const packet = new Uint8Array(length);
        let write = 0;
        for (const part of pending) {
          packet.set(part, write);
          write += part.length;
        }
        packets.push(packet);
        pending = [];
      }
    }
  }
  return { pages, packets, truncated: pending.length > 0 };
}
