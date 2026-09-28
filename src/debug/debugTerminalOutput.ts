export function toUint8Array(message: unknown): Uint8Array {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (Array.isArray(message)) {
    return Uint8Array.from(message.map(Number).filter(Number.isInteger));
  }
  return new Uint8Array();
}

/** Buffered PTY bytes for one Debug Terminal session. */
export class DebugOutputBuffer {
  private readonly chunks = new Map<number, Uint8Array[]>();

  append(sessionId: number, data: Uint8Array): void {
    if (data.length === 0) return;
    const chunks = this.chunks.get(sessionId) ?? [];
    chunks.push(data.slice());
    this.chunks.set(sessionId, chunks);
  }

  consume(sessionId: number): Uint8Array {
    const chunks = this.chunks.get(sessionId);
    if (!chunks || chunks.length === 0) return new Uint8Array();
    this.chunks.delete(sessionId);
    const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }

  clear(sessionId: number): void {
    this.chunks.delete(sessionId);
  }

  clearAll(): void {
    this.chunks.clear();
  }
}