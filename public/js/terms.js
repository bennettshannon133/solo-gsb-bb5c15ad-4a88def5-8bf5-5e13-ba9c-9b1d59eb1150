/*
 * terms.js —— 双语术语核对（无 DOM 依赖，可在浏览器与 Node 中运行）
 *
 * 对照表录入：每行「中文术语=英文译名」（分隔符半角 = 或全角 ＝均可，
 * 按第一个分隔符拆分，两侧空白忽略）：
 *   - 空行（含仅空白行）忽略；
 *   - 缺少分隔符 → 格式错误；中文术语或英文译名为空 → 空值；
 *   - 中文术语重复（无论译名是否相同）→ 重复中文项；
 *   以上问题逐行给出行号提示，存在任一错误即视为对照表无效。
 *
 * 逐段核对（checkParagraphs）：中文正文与英文译文分别按换行拆成非空段落
 * （与排版核心 tokenize 的分段口径一致：段内连续空白合并、去首尾空白），
 * 按顺序一一配对后逐段比较同一术语两侧出现次数：
 *   - 中文术语：每段内从左到右扫描，同一位置最长术语优先，
 *     命中区间不再参与后续匹配（不重复计数）；
 *   - 英文译名：忽略大小写，按完整词组边界计数——命中两侧不得紧邻
 *     单词字符（拉丁字母/数字及词内连字符、撇号，与 layout.js 的
 *     isWordCode 口径一致），命中后不重叠地继续向后计数。
 */
(function (global) {
  'use strict';

  // 构成英文单词的码位：拉丁字母（含扩展区）、数字、单词内部的 - / '
  // （与 layout.js 的 isWordCode 保持一致，用于词组边界判断）
  function isWordCode(ch) {
    if (ch === 0x2d || ch === 0x27 || ch === 0x2010 || ch === 0x2011 ||
        ch === 0x2012 || ch === 0x2013 || ch === 0x2019) {
      return true;
    }
    if (ch >= 0x30 && ch <= 0x39) return true;            // 0-9
    if (ch >= 0x41 && ch <= 0x5a) return true;            // A-Z
    if (ch >= 0x61 && ch <= 0x7a) return true;            // a-z
    if (ch >= 0xc0 && ch <= 0x024f) return true;          // 拉丁扩展
    if (ch >= 0x1e00 && ch <= 0x1eff) return true;        // 拉丁扩展增补
    if (ch >= 0x2c60 && ch <= 0x2c7f) return true;        // 拉丁扩展-C
    if (ch >= 0xa720 && ch <= 0xa7ff) return true;        // 拉丁扩展-D
    if (ch >= 0xab30 && ch <= 0xab6f) return true;        // 拉丁扩展-E
    if (ch >= 0xff10 && ch <= 0xff19) return true;        // 全角数字
    if (ch >= 0xff21 && ch <= 0xff3a) return true;        // 全角大写
    if (ch >= 0xff41 && ch <= 0xff5a) return true;        // 全角小写
    return false;
  }

  // 连续空白（含全角空格、制表符等）合并为单个空格并去首尾空白；
  // 与排版核心 tokenize 的空白归一化口径一致
  function collapseWs(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  // 按换行拆成非空段落（段内空白已归一化），与排版的分段结果一致
  function splitParagraphs(text) {
    return String(text == null ? '' : text)
      .split(/\r\n?|\n/)
      .map(collapseWs)
      .filter(function (p) { return p !== ''; });
  }

  /**
   * 解析双语术语对照表。
   * @param {string} raw 录入文本，每行「中文术语=英文译名」
   * @returns {{entries:Array<{zh:string,en:string,line:number}>, errors:string[]}}
   *   entries 按录入顺序；errors 为逐行错误（含行号），非空即对照表无效。
   */
  function parseGlossary(raw) {
    var lines = String(raw == null ? '' : raw).split(/\r\n?|\n/);
    var entries = [];
    var errors = [];
    var seen = Object.create(null); // 中文术语 → 首次出现的行号
    for (var i = 0; i < lines.length; i++) {
      var text = collapseWs(lines[i]);
      if (text === '') continue; // 空行忽略
      var eq = text.indexOf('=');
      var eqFw = text.indexOf('＝'); // 全角等号同样视为分隔符
      if (eq < 0 || (eqFw >= 0 && eqFw < eq)) eq = eqFw;
      if (eq < 0) {
        errors.push('第 ' + (i + 1) + ' 行「' + text +
          '」格式错误：缺少「=」，请按「中文术语=英文译名」填写。');
        continue;
      }
      var zh = text.slice(0, eq).trim();
      var en = text.slice(eq + 1).trim();
      if (!zh) {
        errors.push('第 ' + (i + 1) + ' 行中文术语为空，请按「中文术语=英文译名」填写。');
        continue;
      }
      if (!en) {
        errors.push('第 ' + (i + 1) + ' 行「' + zh + '」的英文译名为空，请补全。');
        continue;
      }
      if (seen[zh]) {
        errors.push('第 ' + (i + 1) + ' 行中文术语「' + zh + '」与第 ' + seen[zh] +
          ' 行重复，请合并或删除。');
        continue;
      }
      seen[zh] = i + 1;
      entries.push({ zh: zh, en: en, line: i + 1 });
    }
    return { entries: entries, errors: errors };
  }

  /**
   * 中文术语计数：单段内从左到右扫描，同一位置最长术语优先；
   * 命中区间不再参与后续匹配（不重复计数）。
   * @returns {number[]} 与 entries 同序的各术语命中次数
   */
  function countZhTerms(text, entries) {
    var counts = new Array(entries.length).fill(0);
    var n = text.length;
    var pos = 0;
    while (pos < n) {
      var bestLen = 0;
      var bestIdx = -1;
      for (var k = 0; k < entries.length; k++) {
        var t = entries[k].zh;
        // 仅更长者替换；同长同位置即同一字符串（重复项已在解析时拒绝）
        if (t.length <= bestLen || pos + t.length > n) continue;
        if (text.startsWith(t, pos)) { bestLen = t.length; bestIdx = k; }
      }
      if (bestIdx >= 0) {
        counts[bestIdx]++;
        pos += bestLen; // 命中区间不再参与后续匹配
      } else {
        pos++;
      }
    }
    return counts;
  }

  /**
   * 英文译名计数：忽略大小写、按完整词组边界计数（命中两侧不得紧邻
   * 单词字符），命中后不重叠地继续向后计数。
   */
  function countEnPhrase(text, phrase) {
    var lower = String(text).toLowerCase();
    var needle = String(phrase).toLowerCase();
    if (!needle || needle.length > lower.length) return 0;
    var count = 0;
    var pos = 0;
    while (pos <= lower.length - needle.length) {
      var idx = lower.indexOf(needle, pos);
      if (idx < 0) break;
      var beforeOk = idx === 0 || !isWordCode(lower.charCodeAt(idx - 1));
      var afterIdx = idx + needle.length;
      var afterOk = afterIdx >= lower.length ||
        !isWordCode(lower.charCodeAt(afterIdx));
      if (beforeOk && afterOk) {
        count++;
        pos = afterIdx; // 不重叠计数
      } else {
        pos = idx + 1;
      }
    }
    return count;
  }

  /**
   * 逐段核对：中文正文与英文译文按非空段落一一配对，逐段比较
   * 同一术语两侧出现次数。
   * @param {string} zhText 当前选定版本（原稿或修订稿）的中文正文
   * @param {string} enText 英文译文
   * @param {Array} entries parseGlossary 的 entries
   * @returns {{zhParas:number, enParas:number, pairs:number,
   *            mismatches:Array<{para:number,zh:string,en:string,
   *                              zhCount:number,enCount:number}>}}
   *   mismatches 按段号、术语录入顺序排列；调用方应仅在
   *   zhParas === enParas 时采用 mismatches。
   */
  function checkParagraphs(zhText, enText, entries) {
    var zhParas = splitParagraphs(zhText);
    var enParas = splitParagraphs(enText);
    var pairs = Math.min(zhParas.length, enParas.length);
    var mismatches = [];
    for (var i = 0; i < pairs; i++) {
      var zhCounts = countZhTerms(zhParas[i], entries);
      for (var k = 0; k < entries.length; k++) {
        var enCount = countEnPhrase(enParas[i], entries[k].en);
        if (zhCounts[k] !== enCount) {
          mismatches.push({
            para: i + 1,
            zh: entries[k].zh,
            en: entries[k].en,
            zhCount: zhCounts[k],
            enCount: enCount
          });
        }
      }
    }
    return {
      zhParas: zhParas.length,
      enParas: enParas.length,
      pairs: pairs,
      mismatches: mismatches
    };
  }

  var api = {
    parseGlossary: parseGlossary,
    checkParagraphs: checkParagraphs,
    splitParagraphs: splitParagraphs,
    countZhTerms: countZhTerms,
    countEnPhrase: countEnPhrase
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LabelTerms = api;
})(typeof window !== 'undefined' ? window : globalThis);
