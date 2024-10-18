import { Decimal } from "decimal.js";
import { ed25519 } from "@noble/curves/ed25519";
import { bls12_381 as bls } from "@noble/curves/bls12-381";
import { secp256k1 as secp } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { KeyType, type Market, type Token } from "./types";
import * as proto from "./gen/nord";
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
import { ethers } from "ethers";
import fetch from "node-fetch";
import { RequestInfo, RequestInit, Response } from "node-fetch";

export const SESSION_TTL: bigint = 10n * 60n * 1000n * 10000n;
export const ZERO_DECIMAL = new Decimal(0);
export const MAX_BUFFER_LEN = 10_000;

const MAX_PAYLOAD_SIZE = 100 * 1024; // 100 kB

/** Any type convertible to bigint */
export type BigIntValue = bigint | number | string;

export function panic(message: string): never {
  throw new Error(message);
}

export function assert(predicate: boolean, message?: string): void {
  if (!predicate) panic(message ?? "Assertion violated");
}
/**
 * Extracts value out of optional if it's defined, or throws error if it's not
 * @param value   Optional value to unwrap
 * @param message Error message
 * @returns       Unwrapped value
 */
export function optExpect<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value as T;
}
/**
 * Unwraps optional value with default error message
 * @param value
 * @returns
 */
export function optUnwrap<T>(value: T | undefined): T {
  return optExpect(value, "Optional contains no value");
}
/**
 * Applies function to value if it's defined, or passes `undefined` through
 * @param value Optional value to map
 * @param mapFn Mapper function
 * @returns     Either mapped value or undefined
 */
export function optMap<T, U>(
  value: T | undefined,
  mapFn: (arg: T) => U,
): U | undefined {
  return value !== undefined ? mapFn(value) : undefined;
}
/** Behaves same as `node-fetch/fetch` but throws if response is a failure
 *
 * @param url   Request HTTP URL
 * @param init  Request parameters
 * @returns     Raw response if fetch succeeded
 * @throws      If response wasn't Ok
 */
export async function checkedFetch(
  url: RequestInfo,
  init?: RequestInit,
): Promise<Response> {
  const resp = await fetch(url, init);
  assert(resp.ok, `Request failed with ${resp.status}: ${resp.statusText}`);
  return resp;
}

/**
 * Signs an action using the specified secret key and key type.
 * @param action - The action data to be signed.
 * @param sk - Secret key used for signing the action.
 * @param keyType - Type of the key used for signing.
 * @returns A new Uint8Array containing the action followed by its signature.
 */
export function signAction(
  action: Uint8Array,
  sk: Uint8Array,
  keyType: KeyType,
): Uint8Array {
  let sig: Uint8Array;
  if (keyType === KeyType.Ed25519) {
    sig = ed25519.sign(action, sk);
  } else if (keyType === KeyType.Bls12_381) {
    sig = bls.sign(action, sk);
  } else if (keyType === KeyType.Secp256k1) {
    sig = secp.sign(sha256(action), sk).toCompactRawBytes();
  } else {
    throw new Error("Invalid key type");
  }
  return new Uint8Array([...action, ...sig]);
}

/**
 * Constructs wallet signing function, usable with `NordUser` type
 *
 * @param walletKey   Either raw signing key as bytes array or hex string prefixed with `"0x"`
 * @returns           Async function which accepts arbitrary message, generates its digets,
 *                    then signs it with provided user wallet key and returns signature
 *                    as hex string prefixed with `"0x"`
 */
export function makeWalletSignFn(
  walletKey: ethers.BytesLike,
): (message: Uint8Array | string) => Promise<string> {
  const signingKey = new ethers.SigningKey(walletKey);
  return async (message) =>
    signingKey.sign(ethers.hashMessage(message)).serialized;
}

function makeToScaledBigUint(params: {
  precision: number;
  exponent: number;
  bits: number;
}): (x: Decimal.Value, decimals: number) => bigint {
  const Dec = Decimal.clone({
    precision: params.precision,
    toExpPos: params.exponent,
    toExpNeg: -params.exponent,
  });

  const Ten = new Dec(10);

  const Max = new Dec(((1n << BigInt(params.bits)) - 1n).toString());

  return (x, decimals) => {
    const dec = new Dec(x);

    if (dec.isZero()) {
      return 0n;
    }

    if (dec.isNeg()) {
      throw new Error(`Number is negative`);
    }

    const scaled = Ten.pow(decimals).mul(dec).truncated();
    if (scaled.isZero()) {
      throw new Error(
        `Precision loss when converting ${dec} to scaled integer`,
      );
    }

    if (scaled.greaterThan(Max)) {
      throw new Error(
        `Integer is out of range: ${scaled} exceeds limit ${Max}`,
      );
    }

    return BigInt(scaled.toString());
  };
}
/**
 * Converts decimal value into rescaled 64-bit unsigned integer
 * by scaling it up by specified number of decimal digits.
 *
 * Ensures that number won't accidentally become zero
 * or exceed U64's value range
 *
 * @param x         Decimal value to rescale
 * @param decimals  Number of decimal digits
 * @returns         Rescaled unsigned integer
 */
export const toScaledU64 = makeToScaledBigUint({
  bits: 64,
  precision: 20,
  exponent: 28,
});
/**
 * Converts decimal value into rescaled 128-bit unsigned integer
 * by scaling it up by specified number of decimal digits.
 *
 * Ensures that number won't accidentally become zero
 * or exceed U128's value range
 *
 * @param x         Decimal value to rescale
 * @param decimals  Number of decimal digits
 * @returns         Rescaled unsigned integer
 */
export const toScaledU128 = makeToScaledBigUint({
  bits: 128,
  precision: 40,
  exponent: 56,
});

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
/**
 * Converts U128 into pair of U64 numbers, to pass it through protobuf
 * @param value integer, must fit U128 limits
 * @returns     Pair of U64 integers which represent original number split in two
 */
export function bigIntToProtoU128(value: bigint): proto.U128 {
  if (value < 0n) {
    throw new Error(`Negative number (${value})`);
  }

  if (value > U128_MAX) {
    throw new Error(`U128 overflow (${value})`);
  }

  return {
    lo: value & U64_MAX,
    hi: (value >> 64n) & U64_MAX,
  };
}

/**
 * Encodes any protobuf message into a length-delimited format,
 * i.e. prefixed with its length encoded as varint
 * @param   message message object
 * @param   coder   associated coder object which implements `MessageFns` interface
 * @returns         Encoded message as Uint8Array, prefixed with its length
 */
export function encodeLengthDelimited<T, M extends proto.MessageFns<T>>(
  message: T,
  coder: M,
): Uint8Array {
  const encoded = coder.encode(message).finish();
  if (encoded.byteLength > MAX_PAYLOAD_SIZE) {
    throw new Error(
      `Encoded message size (${encoded.byteLength} bytes) is greater than max payload size (${MAX_PAYLOAD_SIZE} bytes).`,
    );
  }
  const encodedLength = new BinaryWriter().uint32(encoded.byteLength).finish();
  return new Uint8Array([...encodedLength, ...encoded]);
}

/**
 * Decodes any protobuf message from a length-delimited format,
 * i.e. prefixed with its length encoded as varint
 *
 * NB: Please note that due to limitations of Typescript type inference
 * it requires to specify variable type explicitly:
 *
 * ```
 * const foo: proto.Bar = decodeLengthDelimited(bytes, proto.Bar);
 * ```
 *
 * @param   bytes Byte array with encoded message
 * @param   coder associated coder object which implements `MessageFns` interface
 * @returns       Decoded Action as Uint8Array.
 */
export function decodeLengthDelimited<T, M extends proto.MessageFns<T>>(
  bytes: Uint8Array,
  coder: M,
): T {
  const lengthReader = new BinaryReader(bytes);
  const msgLength = lengthReader.uint32();
  const startsAt = lengthReader.pos;

  if (msgLength > MAX_PAYLOAD_SIZE) {
    throw new Error(
      `Encoded message size (${msgLength} bytes) is greater than max payload size (${MAX_PAYLOAD_SIZE} bytes).`,
    );
  }

  if (startsAt + msgLength > bytes.byteLength) {
    throw new Error(
      `Encoded message size (${msgLength} bytes) is greater than remaining buffer size (${bytes.byteLength - startsAt} bytes).`,
    );
  }

  return coder.decode(bytes.slice(startsAt, startsAt + msgLength));
}

export function checkPubKeyLength(keyType: KeyType, len: number): void {
  if (keyType === KeyType.Bls12_381) {
    throw new Error(
      "Cannot create a user using Bls12_381, use Ed25119 or Secp256k1 instead.",
    );
  }

  if (len !== 32 && keyType === KeyType.Ed25519) {
    throw new Error("Ed25519 pubkeys must be 32 length.");
  }

  if (len !== 33 && keyType === KeyType.Secp256k1) {
    throw new Error("Secp256k1 pubkeys must be 33 length.");
  }
}

export function findMarket(markets: Market[], marketId: number): Market {
  if (marketId < 0 || markets.length - 1 < marketId) {
    throw new Error(`The market with marketId=${marketId} not found`);
  }
  return markets[marketId];
}

export function findToken(tokens: Token[], tokenId: number): Token {
  if (tokenId < 0 || tokens.length - 1 < tokenId) {
    throw new Error(`The token with tokenId=${tokenId} not found`);
  }
  return tokens[tokenId];
}
