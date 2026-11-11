import type { CollectedOutput } from '@deepseek-ai/dsh-shell'

/** Retain a byte-bounded tail without decoding partial UTF-8 frames separately. */
export class OutputTail {
  private bytes = Buffer.alloc(0)
  private truncated = false

  constructor(private readonly maxBytes: number) {}

  append(chunk: Uint8Array): void {
    if (chunk.byteLength >= this.maxBytes) {
      this.truncated ||= this.bytes.length + chunk.byteLength > this.maxBytes
      this.bytes = Buffer.from(chunk.subarray(chunk.byteLength - this.maxBytes))
      return
    }
    const combined = Buffer.concat([this.bytes, chunk])
    this.truncated ||= combined.length > this.maxBytes
    this.bytes = combined.subarray(Math.max(0, combined.length - this.maxBytes))
  }

  result(): CollectedOutput {
    let start = 0
    if (this.truncated) {
      while (start < this.bytes.length && (this.bytes[start]! & 0xc0) === 0x80) start++
    }
    let text = this.bytes.subarray(start).toString('utf8')
    // Invalid UTF-8 replacement characters can occupy more bytes than their input.
    while (Buffer.byteLength(text) > this.maxBytes) {
      text = text.slice(text.codePointAt(0)! > 0xffff ? 2 : 1)
      this.truncated = true
    }
    return { text, truncated: this.truncated }
  }
}
