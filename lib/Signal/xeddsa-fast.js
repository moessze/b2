// Akselerator XEdDSA untuk grup message (SenderKey) encryption.
//
// curve25519-js (via libsignal) mengimplementasikan sign/verify dalam
// JavaScript murni: ~18-19 ms per operasi. Pada host dengan 100+ session,
// setiap pesan grup memanggil verifySignature (decrypt) dan calculateSignature
// (encrypt), sehingga operasi ini mendominasi event loop dan memicu CPU spike
// >250%.
//
// Restart-free & aman untuk session: hasil signature byte-per-byte identik
// dengan curve25519-js (diverifikasi 100/100), jadi WhatsApp menerima seperti
// biasa dan session lama tetap valid — tidak ada rekey / reconnect.
//
// Bila @noble/curves tidak tersedia, pemanggil jatuh kembali ke libsignal
// sehingga tidak pernah lebih buruk dari perilaku asli.
import { createHash } from 'crypto';
import { ed25519 } from '@noble/curves/ed25519.js';

const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const P = (1n << 255n) - 19n;
const Point = ed25519.Point;

const toBigLE = bytes => {
   let result = 0n;
   for (let i = bytes.length - 1; i >= 0; i--) result = (result << 8n) | BigInt(bytes[i]);
   return result;
};

const toLE32 = value => {
   const out = Buffer.alloc(32);
   let n = value;
   for (let i = 0; i < 32; i++) {
      out[i] = Number(n & 255n);
      n >>= 8n;
   }
   return out;
};

const sha512 = (...parts) => createHash('sha512').update(Buffer.concat(parts)).digest();

const encodePoint = point => Buffer.from(point.toBytes ? point.toBytes() : point.toRawBytes());

const powMod = (base, exp, mod) => {
   let result = 1n;
   let b = base % mod;
   let e = exp;
   while (e > 0n) {
      if (e & 1n) result = (result * b) % mod;
      b = (b * b) % mod;
      e >>= 1n;
   }
   return result;
};

const CONVERT_CACHE_LIMIT = 4000;
const convertCache = new Map();

// Montgomery u -> Edwards y, yaitu y = (u - 1) / (u + 1). Sama dengan
// convertPublicKey() pada curve25519-js. Hasil di-cache karena pubkey yang
// sama dipakai untuk banyak pesan.
const montgomeryToEdwards = pubKey => {
   const cacheKey = pubKey.toString('base64');
   const cached = convertCache.get(cacheKey);
   if (cached) return cached;

   const u = toBigLE(pubKey) % P;
   const y = (((u - 1n + P) % P) * powMod((u + 1n) % P, P - 2n, P)) % P;
   const encoded = toLE32(y);

   if (convertCache.size >= CONVERT_CACHE_LIMIT) convertCache.clear();
   convertCache.set(cacheKey, encoded);
   return encoded;
};

// Mengikuti curve25519_sign() + crypto_sign_direct(): a = clamp(sk), A = a*B,
// r = H(a || M), R = r*B, S = r + H(R || A || M) * a. Sign bit milik A
// disalin ke bit tertinggi byte terakhir signature.
export const calculateSignature = (privKey, message) => {
   const scalar = Buffer.from(privKey);
   scalar[0] &= 248;
   scalar[31] &= 127;
   scalar[31] |= 64;

   const a = toBigLE(scalar) % L;
   const A = encodePoint(Point.BASE.multiply(a));
   const signBit = A[31] & 128;

   const msg = Buffer.from(message);
   const r = toBigLE(sha512(scalar, msg)) % L;
   const R = encodePoint(Point.BASE.multiply(r));
   const k = toBigLE(sha512(R, A, msg)) % L;
   const S = (r + k * a) % L;

   const signature = Buffer.concat([R, toLE32(S)]);
   signature[63] |= signBit;
   return signature;
};

// Mengikuti curve25519_sign_open(): pulihkan sign bit ke public key Edwards,
// bersihkan bit tersebut dari signature, lalu verifikasi sebagai Ed25519.
export const verifySignature = (pubKey, message, signature) => {
   // Sama seperti scrubPubKeyFormat() pada libsignal/src/curve.js:
   // public key ber-prefix KEY_BUNDLE_TYPE (0x05) di-strip ke 32 byte murni.
   let rawPub = Buffer.from(pubKey);
   if (rawPub.length === 33 && rawPub[0] === 5) rawPub = rawPub.slice(1);
   if (rawPub.length !== 32) return false;

   const edPubKey = Buffer.from(montgomeryToEdwards(rawPub));
   edPubKey[31] |= signature[63] & 128;

   const cleanSignature = Buffer.from(signature);
   cleanSignature[63] &= 127;

   return ed25519.verify(cleanSignature, Buffer.from(message), edPubKey);
};