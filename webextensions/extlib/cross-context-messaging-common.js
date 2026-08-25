/*
 license: The MIT License, Copyright (c) 2026 YUKI "Piro" Hiroshi
 original:
   https://github.com/piroor/webextensions-lib-cross-context-messaging
*/
'use strict';

export const MAX_HASH_BYTES = 6000;
export const OVERHEAD = 120;

export async function compressData(data) {
    const jsonStr = JSON.stringify(data);
    const stream = new Response(jsonStr).body.pipeThrough(new CompressionStream('deflate-raw'));
    const compressedBuffer = await new Response(stream).arrayBuffer();
    const bytes = new Uint8Array(compressedBuffer);

    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }

    return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

export async function decompressData(b64UrlSafe) {
    let b64 = b64UrlSafe
        .replace(/-/g, '+')
        .replace(/_/g, '/');
    while (b64.length % 4) {
        b64 += '=';
    }
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('deflate-raw'));
    const decompressedText = await new Response(stream).text();
    return JSON.parse(decompressedText);
}

export function chunkString(str, size) {
    const out = [];
    for (let i = 0; i < str.length; i += size) {
        out.push(str.slice(i, i + size));
    }
    return out;
}
