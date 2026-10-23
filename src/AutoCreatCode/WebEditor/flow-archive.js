(() => {
  'use strict';

  const utf8 = new TextEncoder();
  const decoder = new TextDecoder('utf-8');
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    crcTable[n] = value >>> 0;
  }

  function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  }

  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return utf8.encode(String(value == null ? '' : value));
  }

  function writeStored(files) {
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    let count = 0;
    for (const [name, value] of Object.entries(files || {})) {
      const nameBytes = utf8.encode(name);
      const data = asBytes(value);
      if (nameBytes.length > 65535 || data.length > 0xffffffff) throw new Error('ZIP 文件名或文件内容超过支持范围。');
      const checksum = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const localView = new DataView(local.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint16(8, 0, true);
      localView.setUint32(14, checksum, true);
      localView.setUint32(18, data.length, true);
      localView.setUint32(22, data.length, true);
      localView.setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);
      localParts.push(local, data);

      const central = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(central.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint32(16, checksum, true);
      centralView.setUint32(20, data.length, true);
      centralView.setUint32(24, data.length, true);
      centralView.setUint16(28, nameBytes.length, true);
      centralView.setUint32(42, localOffset, true);
      central.set(nameBytes, 46);
      centralParts.push(central);
      localOffset += local.length + data.length;
      count++;
    }
    if (count > 65535) throw new Error('ZIP 文件数量超过支持范围。');
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, count, true);
    endView.setUint16(10, count, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, localOffset, true);
    return concatenate([...localParts, ...centralParts, end]);
  }

  function concatenate(parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    parts.forEach(part => { output.set(part, offset); offset += part.length; });
    return output;
  }

  async function readEntries(input) {
    const bytes = asBytes(input);
    if (bytes.length < 22) throw new Error('文件不是有效的 ZIP/XLSX 文件。');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const minimum = Math.max(0, bytes.length - 65557);
    let endOffset = -1;
    for (let offset = bytes.length - 22; offset >= minimum; offset--) {
      if (view.getUint32(offset, true) === 0x06054b50) { endOffset = offset; break; }
    }
    if (endOffset < 0) throw new Error('ZIP 文件目录损坏或缺失。');
    const count = view.getUint16(endOffset + 10, true);
    const centralSize = view.getUint32(endOffset + 12, true);
    const centralOffset = view.getUint32(endOffset + 16, true);
    if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff)
      throw new Error('暂不支持 ZIP64 文件。');
    if (centralOffset + centralSize > endOffset) throw new Error('ZIP 中央目录越界。');

    const files = new Map();
    let cursor = centralOffset;
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50)
        throw new Error('ZIP 中央目录条目无效。');
      const flags = view.getUint16(cursor + 8, true);
      const method = view.getUint16(cursor + 10, true);
      const expectedCrc = view.getUint32(cursor + 16, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const uncompressedSize = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const localOffset = view.getUint32(cursor + 42, true);
      const nameStart = cursor + 46;
      const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
      cursor = nameStart + nameLength + extraLength + commentLength;
      if (flags & 1) throw new Error(`ZIP 条目“${name}”已加密，无法导入。`);
      if (method !== 0 && method !== 8) throw new Error(`ZIP 条目“${name}”使用了不支持的压缩方式。`);
      if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50)
        throw new Error(`ZIP 条目“${name}”的文件头无效。`);
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
      let data;
      if (method === 0) data = compressed.slice();
      else {
        if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持解压 XLSX/ZIP；请使用较新的 Edge 或 Chrome。');
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      }
      if (data.length !== uncompressedSize) throw new Error(`ZIP 条目“${name}”解压后的长度不匹配。`);
      if (crc32(data) !== expectedCrc) throw new Error(`ZIP 条目“${name}”校验失败。`);
      if (!name.endsWith('/')) files.set(name, data);
    }
    return files;
  }

  const api = { crc32, writeStored, readEntries };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.FlowArchive = api;
})();
