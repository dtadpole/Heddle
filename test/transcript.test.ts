import assert from 'node:assert/strict'
import { test } from 'node:test'

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
