import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createZstdCompress, zstdCompressSync } from 'node:zlib'

import {
  FRAME_MAGIC,
  decodeTranscript,
  encodeFrame,
  frameEnd,
  isCompressed,
  splitFrames,
} from '../src/session/transcript.ts'

/**
 * The transcript format: one zstd frame per event, appended, read by walking frames.
 *
 * The walk is the risky part — a zstd frame does not record its own length, so the end is only
 * knowable by following the block chain — and the failure it must never have is throwing on a file a
 * crash left half-written. So the torn-tail case is judged at **every** truncation length rather
 * than at one chosen one: an off-by-one in a block header would otherwise pass a single spot check.
 */

const LINES = ['{"seq":0,"type":"session/created"}', '{"seq":1,"type":"message"}', '{"seq":2,"type":"turn/completed"}']

/** A three-frame file, and the plain lines it should decode to. */
function threeFrames(): { buffer: Buffer; frames: readonly Buffer[] } {
  const frames = LINES.map((line) => encodeFrame(line))
  return { buffer: Buffer.concat(frames), frames }
}

test('one event is one frame, with a content checksum', () => {
  const frame = encodeFrame('{"a":1}')
  assert.ok(isCompressed(frame), 'a frame begins with the zstd magic')
  assert.ok(frame.subarray(0, 4).equals(FRAME_MAGIC))
  /**
   * Bit 2 of the frame header descriptor is the content-checksum flag. It is asserted rather than
   * assumed because the option is passed through `params`, and a silently ignored parameter would
   * leave every frame unchecked with nothing to notice it.
   */
  assert.equal((frame[4] ?? 0) & 0x04, 0x04, 'the checksum flag is set')

  const decoded = decodeTranscript(frame)
  assert.deepEqual(decoded.lines, ['{"a":1}'])
  assert.equal(decoded.format, 'zstd-frames')
  assert.equal(decoded.frames, 1)
  assert.equal(decoded.torn, false)
})

test('a file of many frames decodes to every line, in order', () => {
  const { buffer } = threeFrames()
  const decoded = decodeTranscript(buffer)
  assert.deepEqual(decoded.lines, LINES)
  assert.equal(decoded.frames, 3)
  assert.equal(decoded.torn, false)
})

test('appending a frame leaves the earlier bytes identical', () => {
  const first = encodeFrame(LINES[0] ?? '')
  const second = encodeFrame(LINES[1] ?? '')
  const after = Buffer.concat([first, second])
  assert.ok(after.subarray(0, first.length).equals(first), 'the prefix is byte-identical after an append')
})

test('a file truncated at every length decodes to a prefix and never throws', () => {
  const { buffer } = threeFrames()
  for (let length = 0; length <= buffer.length; length += 1) {
    const decoded = decodeTranscript(buffer.subarray(0, length))
    assert.ok(decoded.lines.length <= LINES.length, `length ${length}: never more lines than were written`)
    for (const [index, line] of decoded.lines.entries()) {
      assert.equal(line, LINES[index], `length ${length}: line ${index} is what was written`)
    }
    if (length < buffer.length) {
      assert.ok(decoded.torn || decoded.lines.length < LINES.length, `length ${length}: a short file is reported as torn or short`)
    }
  }
})

test('a corrupted frame ends the readable record rather than failing the read', () => {
  const { buffer, frames } = threeFrames()
  const damaged = Buffer.from(buffer)
  const second = frames[1]
  assert.ok(second !== undefined)
  // Flip a bit inside the second frame's payload: its length stays valid, its content does not.
  damaged[second.length + 8] = (damaged[second.length + 8] ?? 0) ^ 0xff

  const decoded = decodeTranscript(damaged)
  assert.equal(decoded.format, 'zstd-frames')
  assert.deepEqual(decoded.lines, LINES.slice(0, 1), 'the frames before the damage still read')
  assert.equal(decoded.torn, true, 'and the read says the record stopped early')
})

test('a plain transcript is still read, because transcripts written before this format exist', () => {
  const plain = Buffer.from(`${LINES.join('\n')}\n`, 'utf8')
  const decoded = decodeTranscript(plain)
  assert.deepEqual(decoded.lines, LINES)
  assert.equal(decoded.format, 'plain-text')
  assert.equal(decoded.frames, 0)
})

test('the walk stops at garbage rather than searching for a frame', () => {
  const { buffer } = threeFrames()
  const withGarbage = Buffer.concat([buffer, Buffer.from('not a frame')])
  assert.equal(splitFrames(withGarbage).length, 3, 'the three real frames are found')

  const notAFrame = Buffer.from('{"plain":"text"}\n')
  assert.equal(frameEnd(notAFrame, 0), undefined)
  assert.deepEqual(splitFrames(notAFrame), [])
  assert.equal(decodeTranscript(notAFrame).format, 'plain-text')
})

test('readableBytes is the end of the last frame that was read whole', () => {
  const { buffer, frames } = threeFrames()
  assert.equal(decodeTranscript(buffer).readableBytes, buffer.length, 'a whole file is read whole')

  const torn = buffer.subarray(0, buffer.length - 2)
  const decoded = decodeTranscript(torn)
  const firstTwo = (frames[0]?.length ?? 0) + (frames[1]?.length ?? 0)
  assert.equal(decoded.readableBytes, firstTwo, 'a torn third frame is not counted as read')
  assert.equal(decoded.torn, true)

  const damaged = Buffer.from(buffer)
  const second = frames[1]
  assert.ok(second !== undefined)
  damaged[second.length + 8] = (damaged[second.length + 8] ?? 0) ^ 0xff
  assert.equal(decodeTranscript(damaged).readableBytes, frames[0]?.length, 'a frame that will not decode ends the readable record')
})

test('a frame this writer never produces is still read', async () => {
  /**
   * The walker claims to read *frames*, not "frames Node's one-shot compressor makes", so the shapes
   * another writer produces are judged too. A streaming compressor emits a descriptor of `0x00`:
   * no content size, no checksum, and a window descriptor byte — the opposite of every frame the
   * store writes, and the branch that was untested until this check existed.
   */
  const stream = createZstdCompress()
  const parts: Buffer[] = []
  stream.on('data', (chunk: Buffer) => parts.push(chunk))
  const ended = new Promise<void>((resolve) => stream.on('end', () => resolve()))
  stream.end(Buffer.from('{"streamed":true}\n'))
  await ended
  const streamed = Buffer.concat(parts)

  assert.equal(streamed[4], 0x00, 'the streaming descriptor is the one nothing else produces')
  assert.equal(frameEnd(streamed, 0), streamed.length, 'the walk finds its end without a content size')
  assert.deepEqual(decodeTranscript(streamed).lines, ['{"streamed":true}'])

  const mixed = Buffer.concat([encodeFrame('{"ours":1}\n'), streamed, encodeFrame('{"ours":2}\n')])
  assert.equal(splitFrames(mixed).length, 3, 'and both shapes can sit in one file')
  assert.deepEqual(decodeTranscript(mixed).lines, ['{"ours":1}', '{"streamed":true}', '{"ours":2}'])
})

test('a frame whose content size needs four bytes is read', () => {
  /**
   * The frame-header descriptor carries the width of the content-size field, and a small event uses
   * one byte while a large one uses four. Both branches are walked, so both are judged: this is
   * incompressible text on purpose, which is what makes the frame big enough to need the wider field.
   */
  const random = Array.from({ length: 200_000 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')
  const frame = zstdCompressSync(Buffer.from(random))
  assert.equal((frame[4] ?? 0) >> 6, 2, 'the descriptor uses a four-byte content size')

  assert.equal(frameEnd(frame, 0), frame.length, 'the walk finds the end of a large frame')
  const decoded = decodeTranscript(frame)
  assert.equal(decoded.lines.length, 1)
  assert.equal(decoded.lines[0], random, 'and the content is exactly what was compressed')
})
