// Stream the elements of a top-level JSON array, one parsed object at a time.
//
// LongMemEval-M is a single ~2.7 GB JSON array (500 questions x ~500 haystack sessions).
// Parsing it whole needs several GB of heap and can stall a 16 GB machine, so the
// M variant is read element by element: the scanner tracks string/escape state and
// brace depth over raw bytes (every structural character is ASCII, so UTF-8 is
// safe), buffers one element, parses it, yields it, and lets it go. Peak memory is
// one question plus a read chunk.
import { createReadStream } from 'node:fs';

export async function* streamJsonArray(path, { chunkSize = 4 << 20 } = {}) {
  let depth = 0, inStr = false, esc = false, parts = [], start = -1;
  for await (const chunk of createReadStream(path, { highWaterMark: chunkSize })) {
    start = depth >= 2 ? 0 : -1;             // an element spanning chunks continues at byte 0
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === 0x5c) esc = true;          // backslash
        else if (c === 0x22) inStr = false;       // closing quote
        continue;
      }
      if (c === 0x22) { inStr = true; continue; }
      if (c === 0x7b || c === 0x5b) {             // { or [
        depth++;
        if (depth === 2) { parts = []; start = i; } // an element begins (depth 1 = the outer array)
      } else if (c === 0x7d || c === 0x5d) {      // } or ]
        if (depth === 2) {
          parts.push(chunk.subarray(start, i + 1));
          yield JSON.parse(Buffer.concat(parts).toString('utf8'));
          parts = []; start = -1;
        }
        depth--;
      }
    }
    if (depth >= 2 && start >= 0) parts.push(chunk.subarray(start));
  }
}
