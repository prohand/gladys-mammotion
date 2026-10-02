// -----------------------------------------------------------------------------
// Minimal protobuf encoder.
//
// Mammotion mowers take their commands as a protobuf `LubaMsg`, base64-encoded
// and wrapped in the `device_protobuf_sync_service` cloud call. Only a handful
// of messages are needed here, so a few wire-format helpers are enough: no
// .proto compiler, no dependency.
// -----------------------------------------------------------------------------

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

/**
 * Encode an unsigned varint (numbers or bigints, negative values clamp to 0).
 * @param {number | bigint} value
 */
export function encodeVarint(value) {
  let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value) || 0));
  if (v < 0n) {
    v = 0n;
  }
  const bytes = [];
  while (v > 127n) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function tag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}

/** Varint field (int32 / uint32 / int64 / enum / bool). */
export function varintField(fieldNumber, value) {
  return Buffer.concat([tag(fieldNumber, WIRE_VARINT), encodeVarint(value)]);
}

/** Length-delimited field (embedded message or raw bytes). */
export function bytesField(fieldNumber, value) {
  return Buffer.concat([
    tag(fieldNumber, WIRE_LENGTH_DELIMITED),
    encodeVarint(value.length),
    value,
  ]);
}

/** String field (UTF-8). */
export function stringField(fieldNumber, value) {
  return bytesField(fieldNumber, Buffer.from(String(value), 'utf8'));
}

/** 32-bit float field (wire type 5). */
export function floatField(fieldNumber, value) {
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(Number(value));
  return Buffer.concat([tag(fieldNumber, WIRE_FIXED32), buf]);
}

function fixed64(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt.asUintN(64, BigInt(value)));
  return buf;
}

/** Packed repeated fixed64 field (proto3 default for repeated scalars). */
export function packedFixed64Field(fieldNumber, values) {
  return bytesField(fieldNumber, Buffer.concat(values.map(fixed64)));
}

/** Concatenate already-encoded fields into a message. */
export function message(...fields) {
  return Buffer.concat(fields);
}

/**
 * Decode one message level into { fieldNumber: [values] }. Varints and fixed64
 * come back as bigints (unsigned), length-delimited fields as Buffers (decode
 * them again for an embedded message), fixed32 as 4-byte Buffers. Throws on
 * bad data.
 * @param {Buffer} buf
 */
export function decodeMessage(buf) {
  const fields = {};
  let pos = 0;
  const readVarint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (pos >= buf.length) {
        throw new Error('truncated protobuf');
      }
      const byte = buf[pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) {
        return result;
      }
      shift += 7n;
    }
  };
  const push = (field, value) => {
    (fields[field] ??= []).push(value);
  };
  while (pos < buf.length) {
    const key = readVarint();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === WIRE_VARINT) {
      push(field, readVarint());
    } else if (wire === WIRE_LENGTH_DELIMITED) {
      const length = Number(readVarint());
      if (pos + length > buf.length) {
        throw new Error('truncated protobuf');
      }
      push(field, buf.subarray(pos, pos + length));
      pos += length;
    } else if (wire === WIRE_FIXED64) {
      if (pos + 8 > buf.length) {
        throw new Error('truncated protobuf');
      }
      push(field, buf.readBigUInt64LE(pos));
      pos += 8;
    } else if (wire === WIRE_FIXED32) {
      if (pos + 4 > buf.length) {
        throw new Error('truncated protobuf');
      }
      push(field, buf.subarray(pos, pos + 4));
      pos += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  return fields;
}
