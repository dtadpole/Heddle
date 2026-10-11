import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/**
 * The transcript's on-disk format: **one zstd frame per event**, appended.
 *
 * Modelled on `@deepseek-ai/dsh-session`'s `session.v4.jsonl.zstd`, and the reason for the shape is
 * the same: a log that is only ever appended to wants to be compressed *per write* rather than
 * rewritten, and a zstd frame is the smallest unit that can be appended to a compressed file.
 *
 * Three measured facts decide the code below.
 *
 * 1. **Node reads one frame and stops.** `zstdDecompressSync` on a three-frame buffer returns the
 *    first frame's content and silently ignores the rest; the `zstd` CLI decodes all three. So the
 *    reader cannot hand the file to the decompressor — it has to walk the frames itself, which is
 *    what {@link splitFrames} is for. This is the whole reason this module exists rather than a
 *    single `zstdDecompressSync` call.
 * 2. **Appending a frame leaves the earlier bytes identical.** Measured by hashing the prefix before
 *    and after an append. That is the property the format is for, and it is what a check asserts.
 * 3. **A torn tail costs the last frame and nothing else.** The directory walk stops at the first
 *    incomplete frame, so a reader returns every complete event and never throws on a half-written
 *    one — the honest reading of a crash.
 *
 * The cost is stated rather than hidden: one frame per event compresses worse than one frame per
 * file (measured on a real session, 2.13x against 3.49x) because frames share no match window. The
 * alternative — buffering events to batch them — would mean an event on disk *after* the step it
 * describes, which this store refuses to do.
 */

/** The four bytes every zstd frame begins with, little-endian. */
export const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** One frame's byte range inside a transcript. */
export interface Frame {
  readonly start: number
  readonly end: number
}

/** Whether a buffer begins with a whole zstd frame. */
export function isCompressed(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.subarray(0, 4).equals(FRAME_MAGIC)
}

/**
 * Whether a buffer is **meant** to be a transcript of frames, including a truncated one.
 *
 * The distinction matters and was measured: a file cut off after one byte begins with `0x28`, and a
 * reader that only recognised the whole four-byte magic read that byte as plain text and reported a
 * line `'('` — an event nobody wrote. A plain transcript starts with `{` or whitespace, so any
 * prefix of the magic is unambiguous.
 */
export function looksCompressed(buffer: Buffer): boolean {
  if (buffer.length === 0) return false
  const length = Math.min(FRAME_MAGIC.length, buffer.length)
  return buffer.subarray(0, length).equals(FRAME_MAGIC.subarray(0, length))
}

/**
 * Where one frame ends, or `undefined` when it is incomplete or malformed.
 *
 * This walks the frame header and then its blocks, because a zstd frame does not record its own
 * total length: the end is only knowable by following the block chain to the block marked last.
 * Every field it reads is part of the public format (RFC 8878 §3), and anything unexpected ends the
 * walk rather than throwing — a torn tail is a normal thing to find in an appended file.
 */
export function frameEnd(buffer: Buffer, start: number): number | undefined {
  if (start + 4 > buffer.length || !buffer.subarray(start, start + 4).equals(FRAME_MAGIC)) return undefined
  let cursor = start + 4
  if (cursor + 1 > buffer.length) return undefined
  const descriptor = buffer[cursor] ?? 0
  cursor += 1

  const contentSizeFlag = descriptor >> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const checksum = (descriptor & 0x04) !== 0
  const dictionaryFlag = descriptor & 0x03

  if (!singleSegment) cursor += 1 // Window_Descriptor
  cursor += [0, 1, 2, 4][dictionaryFlag] ?? 0 // Dictionary_ID
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][contentSizeFlag] ?? 0
  cursor += contentSizeBytes
  if (cursor > buffer.length) return undefined

  for (;;) {
    if (cursor + 3 > buffer.length) return undefined
    const header = (buffer[cursor] ?? 0) | ((buffer[cursor + 1] ?? 0) << 8) | ((buffer[cursor + 2] ?? 0) << 16)
    cursor += 3
    const lastBlock = (header & 0x01) !== 0
    const blockType = (header >> 1) & 0x03
    const blockSize = header >> 3
    if (blockType === 3) return undefined // reserved
    const payload = blockType === 1 ? 1 : blockSize // an RLE block carries one byte
    cursor += payload
    if (cursor > buffer.length) return undefined
    if (lastBlock) break
  }

  if (checksum) cursor += 4
  return cursor > buffer.length ? undefined : cursor
}

/**
 * Every complete frame in a buffer, in order.
 *
 * The walk stops at the first byte that is not a frame or the first incomplete one, so the result is
 * always "the frames that are fully there" — which is exactly what a reader wants after a crash.
 */
export function splitFrames(buffer: Buffer): readonly Frame[] {
  const frames: Frame[] = []
  let start = 0
  while (start < buffer.length) {
    const end = frameEnd(buffer, start)
    if (end === undefined || end <= start) break
    frames.push({ start, end })
    start = end
  }
  return frames
}

/** One event, compressed as one frame with a content checksum. */
export function encodeFrame(line: string): Buffer {
  return zstdCompressSync(Buffer.from(line, 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
}

/** What a transcript file held, and how it was read. */
export interface DecodedTranscript {
  /** The lines that survived, in order. A torn final frame is simply absent. */
  readonly lines: readonly string[]
  /** How the bytes were stored, so a caller can say what it read. */
  readonly format: 'zstd-frames' | 'plain-text'
  /** Complete frames when compressed; 0 for a plain file. */
  readonly frames: number
  /** True when a trailing byte range was not a complete frame and was left out. */
  readonly torn: boolean
  /**
   * How many bytes were read whole.
   *
   * This is what a repair keeps: the file is cut back to here before anything is appended, because a
   * torn frame in the middle of a file makes every frame **after** it unreadable — the walk stops at
   * the first incomplete frame, so appending past one would write events nothing could ever read.
   * Measured before the repair existed: a torn tail plus one appended frame read back as one event
   * instead of two, with the new event silently gone.
   */
  readonly readableBytes: number
}

/**
 * Read a transcript's bytes, whichever format they are in.
 *
 * Both formats are read forever: transcripts written before this module existed are plain JSONL, and
 * a session that already has one keeps being appended to in the format it has — the store never
 * rewrites a file to change how it is stored.
 */
export function decodeTranscript(buffer: Buffer): DecodedTranscript {
  if (!looksCompressed(buffer)) {
    const text = buffer.toString('utf8')
    return {
      lines: text.split('\n').filter((line) => line.length > 0),
      format: 'plain-text',
      frames: 0,
      torn: false,
      readableBytes: buffer.length,
    }
  }

  const frames = splitFrames(buffer)
  const lines: string[] = []
  let consumed = 0
  for (const frame of frames) {
    const slice = buffer.subarray(frame.start, frame.end)
    let text: string
    try {
      text = zstdDecompressSync(slice).toString('utf8')
    } catch {
      // A frame that cannot be decoded is treated as the end of the readable record rather than as
      // a failure of the whole file: everything before it already decoded.
      consumed = frame.start
      return { lines, format: 'zstd-frames', frames: frames.length, torn: true, readableBytes: consumed }
    }
    lines.push(...text.split('\n').filter((line) => line.length > 0))
    consumed = frame.end
  }
  return { lines, format: 'zstd-frames', frames: frames.length, torn: consumed !== buffer.length, readableBytes: consumed }
}
