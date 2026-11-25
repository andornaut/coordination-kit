// WebSocket framing (RFC 6455) over a byte stream, using only node: builtins: frame encoding and
// decoding, the handshake accept key and text message reassembly. The Codex control client and the
// test control server both speak it.
import { createHash, randomBytes } from "node:crypto";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export const OPCODE = { binary: 2, close: 8, ping: 9, pong: 10, text: 1 } as const;

interface Frame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

/** One WebSocket frame. Clients mask their frames; servers do not. */
export function encodeFrame(masked: boolean, opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 0x10000) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  if (!masked) {
    return Buffer.concat([header, payload]);
  }
  header[1] = (header[1] ?? 0) | 0x80;
  const mask = randomBytes(4);
  const body = Buffer.from(payload);
  for (let index = 0; index < body.length; index += 1) {
    body[index] = (body[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  return Buffer.concat([header, mask, body]);
}

/** Splits a byte stream into frames; returns the frames and the unconsumed remainder. */
export function decodeFrames(buffer: Buffer): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) {
      break;
    }
    const first = buffer[offset] ?? 0;
    const second = buffer[offset + 1] ?? 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) {
        break;
      }
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) {
        break;
      }
      const wide = buffer.readBigUInt64BE(cursor);
      if (wide > BigInt(MAX_MESSAGE_BYTES)) {
        throw new Error("native frame too large");
      }
      length = Number(wide);
      cursor += 8;
    }
    const masked = (second & 0x80) !== 0;
    const maskStart = cursor;
    if (masked) {
      cursor += 4;
    }
    if (buffer.length - cursor < length) {
      break;
    }
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (masked) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = (payload[index] ?? 0) ^ (buffer[maskStart + (index % 4)] ?? 0);
      }
    }
    frames.push({ fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload });
    offset = cursor + length;
  }
  return { frames, rest: Buffer.from(buffer.subarray(offset)) };
}

/** The Sec-WebSocket-Accept value for a handshake key. */
export function acceptKey(key: string): string {
  return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

/** Reassembles text messages from frames and answers pings. */
export class MessageAssembler {
  private fragments: Buffer[] = [];
  private readonly reply: (opcode: number, payload: Buffer) => void;

  constructor(reply: (opcode: number, payload: Buffer) => void) {
    this.reply = reply;
  }

  /** Returns completed messages, or null when the peer closed the connection. */
  accept(frames: readonly Frame[]): string[] | null {
    const messages: string[] = [];
    for (const frame of frames) {
      if (frame.opcode === OPCODE.close) {
        return null;
      }
      if (frame.opcode === OPCODE.ping) {
        this.reply(OPCODE.pong, frame.payload);
      } else if (frame.opcode !== OPCODE.pong) {
        this.fragments.push(frame.payload);
        if (frame.fin) {
          messages.push(Buffer.concat(this.fragments).toString("utf8"));
          this.fragments = [];
        }
      }
    }
    return messages;
  }
}
