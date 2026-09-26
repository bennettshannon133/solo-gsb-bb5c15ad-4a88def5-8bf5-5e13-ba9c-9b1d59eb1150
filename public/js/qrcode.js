/*
 * qrcode.js —— 展品介绍链接的二维码生成（无 DOM 依赖，可在浏览器与 Node 中运行）
 *
 * 自包含的 QR Code 编码器，不依赖任何外部服务或库：
 *   - 字节模式（文本按 UTF-8 编码，与 TextEncoder 行为一致）；
 *   - 纠错等级固定为 M（约 15% 冗余，展签扫码场景的常用选择）；
 *   - 版本 1～10 自动选最小可容纳版本（版本 6-M 即可容纳 100 字节）；
 *   - 八种掩码按 ISO/IEC 18004 罚分规则自动择优。
 *
 * LabelQR.encode(text)：
 *   成功 → { size, version, mask, modules }，modules[y][x] 为 true 表示深色模块；
 *   失败 → { error: 'capacity', maxBytes }（数据超出版本 10-M 容量）。
 * LabelQR.byteLength(text)：返回文本的 UTF-8 字节数（供输入框计数提示）。
 */
(function (global) {
  'use strict';

  var MIN_VERSION = 1;
  var MAX_VERSION = 10;

  // 版本 1～10、纠错等级 M 的 RS 分块表：[块数, 每块总码字, 每块数据码字]
  var RS_BLOCKS = [
    null,
    [[1, 26, 16]],                      // 1
    [[1, 44, 28]],                      // 2
    [[1, 70, 44]],                      // 3
    [[2, 50, 32]],                      // 4
    [[2, 67, 43]],                      // 5
    [[4, 43, 27]],                      // 6
    [[4, 49, 31]],                      // 7
    [[2, 60, 38], [2, 61, 39]],         // 8
    [[3, 58, 36], [2, 59, 37]],         // 9
    [[4, 69, 43], [1, 70, 44]]          // 10
  ];

  // 各版本校正图形（alignment pattern）的中心坐标表
  var ALIGN_POS = [
    null,
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50]
  ];

  // ---------- UTF-8 字节编码（孤立代理项与 TextEncoder 一样替换为 U+FFFD） ----------
  function utf8Bytes(str) {
    var s = String(str == null ? '' : str);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff &&
                 i + 1 < s.length &&
                 s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) {
        var cp = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(i + 1) - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else if (c >= 0xd800 && c <= 0xdfff) {
        out.push(0xef, 0xbf, 0xbd); // 孤立代理项 → U+FFFD
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return out;
  }

  // ---------- 有限域 GF(2^8)，本原多项式 0x11D ----------
  var GF_EXP = new Array(512);
  var GF_LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) GF_EXP[j] = GF_EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  // RS 生成多项式（degree 个纠错码字），返回按升幂排列的系数（去掉最高次项）
  function rsDivisor(degree) {
    var result = new Array(degree);
    for (var i = 0; i < degree; i++) result[i] = 0;
    result[degree - 1] = 1;
    var root = 1;
    for (var d = 0; d < degree; d++) {
      for (var j = 0; j < degree; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }

  // 数据多项式除以生成多项式的余数（即纠错码字）
  function rsRemainder(data, divisor) {
    var result = new Array(divisor.length);
    for (var i = 0; i < result.length; i++) result[i] = 0;
    for (var k = 0; k < data.length; k++) {
      var factor = data[k] ^ result[0];
      result.shift();
      result.push(0);
      for (var j = 0; j < result.length; j++) {
        result[j] ^= gfMul(divisor[j], factor);
      }
    }
    return result;
  }

  // ---------- 位流 ----------
  function appendBits(bits, val, len) {
    for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  }

  function numDataCodewords(version) {
    var total = 0;
    RS_BLOCKS[version].forEach(function (g) { total += g[0] * g[2]; });
    return total;
  }

  // 数据分块、计算纠错码字并交错排列
  function addEccAndInterleave(data, version) {
    var groups = RS_BLOCKS[version];
    var numBlocks = 0, rawCodewords = 0, blockEccLen = 0;
    groups.forEach(function (g) {
      numBlocks += g[0];
      rawCodewords += g[0] * g[1];
      blockEccLen = g[1] - g[2]; // 同一版本内各组纠错长度一致
    });
    var numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);
    var divisor = rsDivisor(blockEccLen);

    var blocks = [];
    var k = 0;
    for (var i = 0; i < numBlocks; i++) {
      var datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
      var dat = data.slice(k, k + datLen);
      k += datLen;
      var ecc = rsRemainder(dat, divisor);
      if (i < numShortBlocks) dat.push(0); // 短块补占位字节，交错时跳过
      blocks.push(dat.concat(ecc));
    }

    var result = [];
    for (var j = 0; j < blocks[0].length; j++) {
      for (var b = 0; b < numBlocks; b++) {
        if (j === shortBlockLen - blockEccLen && b < numShortBlocks) continue;
        result.push(blocks[b][j]);
      }
    }
    return result;
  }

  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  // ---------- 矩阵 ----------
  function QrMatrix(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = [];
    this.isFunction = [];
    for (var y = 0; y < this.size; y++) {
      var row = [], frow = [];
      for (var x = 0; x < this.size; x++) { row.push(false); frow.push(false); }
      this.modules.push(row);
      this.isFunction.push(frow);
    }
  }

  QrMatrix.prototype.setFunction = function (x, y, dark) {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  };

  // 位置探测图形（含分隔带），(cx, cy) 为中心
  QrMatrix.prototype.drawFinder = function (cx, cy) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var x = cx + dx, y = cy + dy;
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
          this.setFunction(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
  };

  // 校正图形，(cx, cy) 为中心
  QrMatrix.prototype.drawAlign = function (cx, cy) {
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        this.setFunction(cx + dx, cy + dy,
          Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  };

  // 格式信息（纠错等级 M 的格式位为 0；掩码确定前以 0 占位，之后重画）
  QrMatrix.prototype.drawFormatBits = function (mask) {
    var data = mask; // (eclM << 3) | mask，eclM = 0
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;
    var size = this.size;

    for (i = 0; i <= 5; i++) this.setFunction(8, i, getBit(bits, i));
    this.setFunction(8, 7, getBit(bits, 6));
    this.setFunction(8, 8, getBit(bits, 7));
    this.setFunction(7, 8, getBit(bits, 8));
    for (i = 9; i < 15; i++) this.setFunction(14 - i, 8, getBit(bits, i));

    for (i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, getBit(bits, i));
    for (i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, getBit(bits, i));
    this.setFunction(8, size - 8, true); // 固定深色模块
  };

  // 版本信息（版本 ≥ 7 才有）
  QrMatrix.prototype.drawVersionBits = function () {
    if (this.version < 7) return;
    var rem = this.version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    var bits = (this.version << 12) | rem;
    for (i = 0; i < 18; i++) {
      var bit = getBit(bits, i);
      var a = this.size - 11 + (i % 3);
      var b = Math.floor(i / 3);
      this.setFunction(a, b, bit);
      this.setFunction(b, a, bit);
    }
  };

  QrMatrix.prototype.drawFunctionPatterns = function () {
    var size = this.size;
    for (var i = 0; i < size; i++) {
      this.setFunction(6, i, i % 2 === 0); // 垂直 timing
      this.setFunction(i, 6, i % 2 === 0); // 水平 timing
    }
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);

    var pos = ALIGN_POS[this.version];
    for (var a = 0; a < pos.length; a++) {
      for (var b = 0; b < pos.length; b++) {
        // 三个角与位置探测图形重叠，跳过
        if ((a === 0 && b === 0) ||
            (a === 0 && b === pos.length - 1) ||
            (a === pos.length - 1 && b === 0)) continue;
        this.drawAlign(pos[a], pos[b]);
      }
    }
    this.drawFormatBits(0);
    this.drawVersionBits();
  };

  // 数据码字按 Z 字形填入非功能模块
  QrMatrix.prototype.drawCodewords = function (data) {
    var i = 0, size = this.size;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  };

  QrMatrix.prototype.applyMask = function (mask) {
    for (var y = 0; y < this.size; y++) {
      for (var x = 0; x < this.size; x++) {
        if (this.isFunction[y][x]) continue;
        var invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
          case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
          default: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
        }
        if (invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  };

  // ISO/IEC 18004 掩码罚分：连续同色、2×2 同色块、类定位图形、深浅比例
  QrMatrix.prototype.penaltyScore = function () {
    var size = this.size, result = 0, x, y, k;

    // 规则 1 + 3：逐行、逐列扫描（行/列两端各补 4 个虚拟浅色模块，覆盖边缘情形）
    var dirs = ['row', 'col'];
    for (var d = 0; d < 2; d++) {
      for (var i = 0; i < size; i++) {
        var line = [false, false, false, false];
        for (var j = 0; j < size; j++) {
          line.push(d === 0 ? this.modules[i][j] : this.modules[j][i]);
        }
        line.push(false, false, false, false);

        var runColor = line[0], runLen = 1;
        for (k = 1; k < line.length; k++) {
          if (line[k] === runColor) {
            runLen++;
          } else {
            if (runLen >= 5) result += 3 + (runLen - 5); // 规则 1
            runColor = line[k];
            runLen = 1;
          }
        }
        if (runLen >= 5) result += 3 + (runLen - 5);

        for (k = 0; k + 11 <= line.length; k++) { // 规则 3：00001011101 / 10111010000
          var p = 0;
          for (var m = 0; m < 11; m++) p = (p << 1) | (line[k + m] ? 1 : 0);
          if (p === 0x05d || p === 0x5d0) result += 40;
        }
      }
    }

    // 规则 2：2×2 同色块
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var c = this.modules[y][x];
        if (c === this.modules[y][x + 1] &&
            c === this.modules[y + 1][x] &&
            c === this.modules[y + 1][x + 1]) result += 3;
      }
    }

    // 规则 4：深浅模块比例（size 为奇数，深色比例不可能恰为 50%）
    var dark = 0;
    for (y = 0; y < size; y++) {
      for (x = 0; x < size; x++) if (this.modules[y][x]) dark++;
    }
    var total = size * size;
    var kk = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += kk * 10;

    return result;
  };

  // ---------- 编码入口 ----------
  function encode(text) {
    var data = utf8Bytes(text);

    // 选最小可容纳版本：模式指示 4 位 + 字数指示（1～9 版 8 位，10 版起 16 位）+ 数据
    var version = 0, capacityBits = 0;
    for (var v = MIN_VERSION; v <= MAX_VERSION; v++) {
      var cap = numDataCodewords(v) * 8;
      var countBits = v <= 9 ? 8 : 16;
      if (4 + countBits + data.length * 8 <= cap) {
        version = v;
        capacityBits = cap;
        break;
      }
    }
    if (!version) {
      return { error: 'capacity', maxBytes: maxByteCapacity() };
    }

    // 拼接数据位流：模式 0100 + 字数 + 数据 + 终止符 + 对齐 + 填充字节
    var bits = [];
    appendBits(bits, 0x4, 4);
    appendBits(bits, data.length, version <= 9 ? 8 : 16);
    data.forEach(function (b) { appendBits(bits, b, 8); });
    appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);
    for (var pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) {
      appendBits(bits, pad, 8);
    }
    var dataCodewords = [];
    for (var i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      dataCodewords.push(b);
    }

    var qr = new QrMatrix(version);
    qr.drawFunctionPatterns();
    qr.drawCodewords(addEccAndInterleave(dataCodewords, version));

    // 八种掩码逐一试算，取罚分最低者
    var bestMask = 0, bestPenalty = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      qr.applyMask(mask);
      qr.drawFormatBits(mask);
      var penalty = qr.penaltyScore();
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestMask = mask;
      }
      qr.applyMask(mask); // 撤销试算
    }
    qr.applyMask(bestMask);
    qr.drawFormatBits(bestMask);

    return {
      size: qr.size,
      version: version,
      mask: bestMask,
      modules: qr.modules
    };
  }

  // 版本 10-M 字节模式的最大数据容量（含模式/字数指示开销）
  function maxByteCapacity() {
    var capBits = numDataCodewords(MAX_VERSION) * 8;
    return Math.floor((capBits - 4 - 16) / 8);
  }

  var api = {
    encode: encode,
    byteLength: function (text) { return utf8Bytes(text).length; },
    MAX_VERSION: MAX_VERSION
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LabelQR = api;
})(typeof window !== 'undefined' ? window : globalThis);
