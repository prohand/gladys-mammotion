// -----------------------------------------------------------------------------
// Minimal protobuf encoder.
//
// Mammotion mowers take their commands as a protobuf `LubaMsg`, base64-encoded
// and wrapped in the `device_protobuf_sync_service` cloud call. Only a handful
// of messages are needed here, so a few wire-format helpers are enough: no
// .proto compiler, no dependency.
// -----------------------------------------------------------------------------

const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;

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

/** Concatenate already-encoded fields into a message. */
export function message(...fields) {
  return Buffer.concat(fields);
}
