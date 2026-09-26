/*
 * layout.js —— 展签排版核心算法（无 DOM 依赖，可在浏览器与 Node 中运行）
 *
 * 分词规则：
 *   1. 英文单词（连续拉丁字母/数字及单词内部连字符、撇号）为不可拆整体；
 *   2. 每个汉字为一个可断点的独立 token；
 *   3. 闭标点（、。，！？：；）”’】》〉…—· 等）不得出现在行首；
 *      开标点（“‘【《〈 等）不得出现在行尾；
 *   4. 连续空白合并为一个空格，换行符作为强制分段。
 *
 * 中文专名保护（protectedWords）：
 *   每段内从左到右扫描，同一位置优先最长保护词、同长按录入顺序；
 *   已匹配字符不再参与后续匹配。命中区间不改变分词结果，而是与原词
 *   （英文单词等）自身的不可断性「求并」：区间触达的相邻 token 之间
 *   追加不可断边，整体形成不可断原子块。部分重叠（如单词 pottery 命中
 *   ott）或跨词命中都不新增词内断点；原子块整体超宽即报失败。
 *   标点避头尾按原子块实际首尾字符判断，区间内部括号不影响合法断点。
 *   仅用于标题与中文正文。
 *
 * 断行算法：动态规划。在满足宽度与标点规则的所有可行排法中，
 * 最小化「非末行的空白宽度平方和」（与 TeX 段落断行同一思想），
 * 代价比相同时取行数更少、断点更靠右的方案，保证结果确定唯一。
 *
 * 超宽失败：planText 返回 { error:'width', overflows:[...] }，
 * overflows 列出每一个超出行宽的不可断原子块（英文单词，或因保护词
 * 绑定多 token 形成的整体）。
 */
(function (global) {
  'use strict';

  var PX_PER_MM = 96 / 25.4; // CSS 标准：1mm = 96/25.4 px ≈ 3.7795px

  // ---------- 标点集合（按码位构造，支持 BMP 与增补平面） ----------
  function codeSet(str) {
    var set = Object.create(null);
    var cp = Array.from(str);
    for (var i = 0; i < cp.length; i++) set[cp[i].codePointAt(0)] = true;
    return set;
  }

  // 开标点（含左括号、左引号）：不得置于行尾
  var OPEN_CHARS =
    '“‘〖【《〈「『｟（〔［｛([{';
  var OPEN_SET = codeSet(OPEN_CHARS);

  // 闭标点（含句读点、右括号、右引号、省略号/破折号等）：不得置于行首
  var CLOSE_CHARS =
    '”’〗】》〉」』｠）〕］｝)]}' +
    '、。，．！？：；.,!?;:' +
    '…—–·・‥～〽′″〟»' +
    '％%‰℃℉°＇›';
  var CLOSE_SET = codeSet(CLOSE_CHARS);

  var SPACE_CODES = (function () {
    var s = Object.create(null);
    [0x20, 0x09, 0x0b, 0x0c, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
     0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f,
     0x3000].forEach(function (c) { s[c] = true; });
    return s;
  })();

  // 构成英文单词的码位：拉丁字母（含扩展区）、数字、单词内部的 - / '
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

  // 全角样式的拉丁/数字在排版中等价于普通词字符
  function isCJKCode(ch) {
    return (
      (ch >= 0x2e80 && ch <= 0x9fff) ||   // CJK 部首/汉字（含假名 0x3040 区段、兼容）
      (ch >= 0x3040 && ch <= 0x30ff) ||   // 平假名、片假名
      (ch >= 0x3400 && ch <= 0x4dbf) ||   // 扩展 A
      (ch >= 0xf900 && ch <= 0xfaff) ||   // 兼容汉字
      (ch >= 0x20000 && ch <= 0x2a6df) ||
      (ch >= 0x2a700 && ch <= 0x2b73f) ||
      (ch >= 0x2b740 && ch <= 0x2b81f) ||
      (ch >= 0x2b820 && ch <= 0x2ceaf) ||
      (ch >= 0x30000 && ch <= 0x3134f)
    );
  }

  function typeOf(ch) {
    if (SPACE_CODES[ch]) return 'space';
    if (OPEN_SET[ch]) return 'open';
    if (CLOSE_SET[ch]) return 'close';
    if (isWordCode(ch)) return 'word';
    return 'char'; // 汉字及其他字符：按不可再分、两侧可断处理
  }

  /**
   * 分词 → 段落数组。返回 Array<Array<Token>>，每个 token：
   * { t: 文本, type: 'word'|'char'|'open'|'close'|'space', ch: 首码位 }
   * 已去除空段、合并连续空白、去掉段首尾空白。
   *
   * 专名保护不在分词阶段改写 token：protectedWords 仅用于与 layout 层
   * 一致的分段计数（外部按 tokenize(...).length 统计非空段落数）；
   * 命中区间在 planParagraph 中以「不可断边」形式叠加到原 token 上。
   *
   * @param {string} text 原文
   * @param {string[]} [protectedWords] 中文专名保护词表（兼容签名，
   *        分词结果不随词表变化；不可断约束见 planParagraph）。
   */
  function tokenize(text, protectedWords) {
    var paragraphs = [];
    var cur = null;

    function flush() {
      if (cur && cur.length) paragraphs.push(cur);
      cur = null;
    }

    var chars = Array.from(String(text == null ? '' : text));
    for (var i = 0; i < chars.length; i++) {
      var raw = chars[i];
      var ch = raw.codePointAt(0);

      if (ch === 0x0a || ch === 0x0d) {
        if (ch === 0x0d && chars[i + 1] && chars[i + 1].codePointAt(0) === 0x0a) i++;
        flush();
        continue;
      }

      var type = typeOf(ch);
      if (type === 'space') {
        if (cur && cur.length && cur[cur.length - 1].type !== 'space') {
          cur.push({ t: ' ', type: 'space', ch: 0x20 });
        }
        continue;
      }

      if (!cur) cur = [];

      if (type === 'word') {
        // 合并连续词字符（含词内 - '），遇到标点/空格/汉字即停止
        var s = raw;
        while (i + 1 < chars.length) {
          var nch = chars[i + 1].codePointAt(0);
          if (!isWordCode(nch)) break;
          s += chars[++i];
        }
        cur.push({ t: s, type: 'word', ch: s.codePointAt(0) });
      } else if (isCJKCode(ch) || type === 'open' || type === 'close') {
        cur.push({ t: raw, type: type === 'char' ? 'char' : type, ch: ch });
      } else {
        cur.push({ t: raw, type: 'char', ch: ch });
      }
    }
    flush();

    // 去掉每段首尾空格 token。专名保护在断行阶段以不可断边叠加，不改写分词。
    return paragraphs.map(function (tokens) {
      var a = 0, b = tokens.length;
      while (a < b && tokens[a].type === 'space') a++;
      while (b > a && tokens[b - 1].type === 'space') b--;
      return tokens.slice(a, b);
    }).filter(function (tokens) { return tokens.length > 0; });
  }

  // ---------- 中文专名保护 ----------

  // 词表归一化：按码位去空词，供算法层兜底（UI 层已完成校验与去重）
  function normalizeProtectedWords(protectedWords) {
    if (!protectedWords || !protectedWords.length) return [];
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < protectedWords.length; i++) {
      var w = String(protectedWords[i]);
      if (!w || seen[w]) continue;
      seen[w] = true;
      out.push({ text: w, chars: Array.from(w) });
    }
    return out;
  }

  /**
   * 在单段 token 序列上从左到右匹配保护词，返回互不重叠的命中区间
   * （相对 token 拼接文本的码位下标，闭开区间 [start, start+len)）。
   * 同一位置优先最长词；同长按词表录入顺序（words 已去重并保序）。
   * 保护词不含空白（UI 层保证），故命中区间不会跨过空格 token。
   */
  function matchProtection(tokens, words) {
    var chars = [];
    var offsets = [];
    for (var i = 0; i < tokens.length; i++) {
      var tcs = Array.from(tokens[i].t);
      for (var j = 0; j < tcs.length; j++) {
        chars.push(tcs[j]);
        offsets.push(i);
      }
    }
    var n = chars.length;
    var intervals = [];
    var pos = 0;
    while (pos < n) {
      var bestLen = 0;
      for (var k = 0; k < words.length; k++) {
        var wc = words[k].chars;
        if (wc.length <= bestLen || pos + wc.length > n) continue;
        var hit = true;
        for (var m = 0; m < wc.length; m++) {
          // 保护词不含空白（UI 层保证）；兜底：不跨空格 token 匹配
          if (tokens[offsets[pos + m]].type === 'space' ||
              chars[pos + m] !== wc[m]) { hit = false; break; }
        }
        if (hit) bestLen = wc.length; // 更长才替换；同长保持较早录入的词
      }
      if (bestLen > 0) {
        intervals.push({ start: pos, end: pos + bestLen });
        pos += bestLen; // 已匹配字符不再参与后续匹配
      } else {
        pos++;
      }
    }
    return intervals;
  }

  /**
   * 计算单段内 token 之间的「不可断边」。
   *
   * 两类约束取并集：
   *   1. 原词自身不可断：英文单词等在分词阶段已是完整 token，天然不产生
   *      词内断点（保护词部分重叠时绝不切开原词）；
   *   2. 保护命中区间触达的相邻 token 绑定：区间覆盖到的每个 token 与
   *      下一个被覆盖的非空格 token 之间不可断。保护词不含空白，且匹配
   *      不跨空格 token，故一条不可断边两端必为相邻的可见 token；跨词
   *      命中会把沿途 token 全部绑成一个原子块。
   *
   * 返回 { noBreak: Uint8Array(n), bound: Uint8Array(n) }：
   *   noBreak[i] = tokens[i] 与 tokens[i+1] 之间不可断（i = 0..n-2）；
   *   bound[i]   = tokens[i] 被某保护区间触达（含单 token 完整命中），
   *                用于超宽报告时把该原子块标注为「保护词整体」。
   */
  function buildNoBreakEdges(tokens, words) {
    var n = tokens.length;
    var noBreak = new Uint8Array(n);
    var bound = new Uint8Array(n);
    if (!words || !words.length) return { noBreak: noBreak, bound: bound };

    var intervals = matchProtection(tokens, words);
    if (!intervals.length) return { noBreak: noBreak, bound: bound };

    // 全局码位偏移 → token 下标；tokenEnd[i] 为 token i 的全局排他终点
    var owner = [];
    var tokenEnd = [];
    var acc = 0;
    for (var i = 0; i < n; i++) {
      var cps = Array.from(tokens[i].t);
      for (var j = 0; j < cps.length; j++) owner.push(i);
      acc += cps.length;
      tokenEnd.push(acc);
    }

    for (var k = 0; k < intervals.length; k++) {
      var end = intervals[k].end;
      // 从区间起点所属 token 起，按 token 逐个推进到区间终点。
      // matchProtection 保证区间不跨空格 token，故触达的必为连续可见 token。
      var first = owner[intervals[k].start];
      var last = first;
      var pos = intervals[k].start;
      while (pos < end) {
        last = owner[pos];
        bound[last] = 1;
        pos = tokenEnd[last];
      }
      // [first, last] 内相邻 token 全部并入同一原子块
      for (var e = first; e < last; e++) noBreak[e] = 1;
    }
    return { noBreak: noBreak, bound: bound };
  }

  var DASH_CHARS = (function () {
    var s = Object.create(null);
    [0x2014, 0x2015, 0x2013, 0x2012].forEach(function (c) { s[c] = true; });
    return s;
  })();

  /**
   * 单段动态规划断行。
   * @param {Token[]} tokens   已分段的 token（分词结果，不含 protect 改写）
   * @param {number} maxWidth  行宽（px）
   * @param {(s:string)=>number} measure 文本宽度函数（px）
   * @param {boolean} lastLineFree 末行是否不计空白代价（正文最后一段为 true）
   * @param {string[]} [protectedWords] 中文专名保护词表：命中区间在原词
   *        不可断性之上再叠加不可断边，共同形成不可断原子块
   * @returns {{lines:string[], widths:number[], tokens:Token[][],
   *            overflows:Array<{text:string,width:number,protect:boolean}>}}
   *          放不下（存在超过行宽的不可断原子块，含保护词整体）时 overflows 非空
   */
  function planParagraph(tokens, maxWidth, measure, lastLineFree, protectedWords) {
    var n = tokens.length;
    if (n === 0) return { lines: [], widths: [], tokens: [], overflows: [] };

    // 不可断边：原词自身 + 保护命中区间绑定，共同构成不可断原子块
    var words = normalizeProtectedWords(protectedWords);
    var edges = buildNoBreakEdges(tokens, words);
    var noBreak = edges.noBreak;
    var bound = edges.bound;

    // 每个 token 所属原子块编号：沿 noBreak 边顺序合并（块内 token 连续）
    var blockOf = new Int32Array(n);
    var blocks = []; // {end,width,text,protect}（块内通常不含空格；空格不计宽）
    var bid = 0;
    for (var bi = 0; bi < n; bi++) {
      if (bi === 0 || !noBreak[bi - 1]) {
        blockOf[bi] = bid++;
        blocks.push({ end: bi + 1, width: 0, text: '', protect: false });
      } else {
        blockOf[bi] = blockOf[bi - 1];
      }
      blocks[blockOf[bi]].end = bi + 1;
    }

    // 预处理：左右最近的非空格 token 下标，用于跨行标点判断
    var prevNonSpace = new Int32Array(n);
    var nextNonSpace = new Int32Array(n);
    var p = -1;
    for (var i = 0; i < n; i++) {
      prevNonSpace[i] = p;
      if (tokens[i].type !== 'space') p = i;
    }
    var q = n;
    for (var j = n - 1; j >= 0; j--) {
      nextNonSpace[j] = q;
      if (tokens[j].type !== 'space') q = j;
    }

    // 原子块的实际首尾码位：标点避头尾只看块边界，内部括号不参与判断
    function firstCp(tok) {
      return Array.from(tok.t)[0].codePointAt(0);
    }
    function lastCp(tok) {
      var cs = Array.from(tok.t);
      return cs[cs.length - 1].codePointAt(0);
    }
    // 行尾可见 token：以其实际最后一个码位判断开标点（开标点不得在行尾）
    function endsOpen(tok) {
      return !!OPEN_SET[lastCp(tok)];
    }
    // 行首可见 token：以其实际第一个码位判断闭标点（闭标点不得在行首）
    function startsClose(tok) {
      return !!CLOSE_SET[firstCp(tok)];
    }

    // w[i] = token 宽度
    var w = new Array(n);
    for (var k = 0; k < n; k++) {
      w[k] = tokens[k].type === 'space' ? measure(' ') : measure(tokens[k].t);
    }

    // 汇总每个不可断原子块的宽度/文本，收集超出行宽的整体
    // （英文单词本身是单 token 块；保护词跨词绑定时是多 token 块）
    for (var wi = 0; wi < n; wi++) {
      var blk = blocks[blockOf[wi]];
      if (tokens[wi].type !== 'space') {
        blk.width += w[wi];
        blk.text += tokens[wi].t;
      }
      if (bound[wi]) blk.protect = true;
    }
    var overflows = [];
    var seenBlock = new Uint8Array(blocks.length);
    for (var oi = 0; oi < n; oi++) {
      var ob = blockOf[oi];
      if (seenBlock[ob] || tokens[oi].type === 'space') continue;
      seenBlock[ob] = 1;
      var oblk = blocks[ob];
      if (oblk.width > maxWidth + 0.5) {
        overflows.push({
          text: oblk.text,
          width: oblk.width,
          protect: oblk.protect
        });
      }
    }
    if (overflows.length) return { lines: [], widths: [], tokens: [], overflows: overflows };

    function canBreakBetween(a, b) {
      if (a < 0 || b >= n) return true;
      var L = tokens[a], R = tokens[b];
      // 不可断原子块内部不得有断点（原词整体 + 保护区间绑定）
      if (blockOf[a] === blockOf[b]) return false;
      // 左侧原子块的实际末尾字符不能是开标点（开标点不在行尾）
      if (endsOpen(L)) return false;
      // 右侧原子块的实际首字符不能是闭标点（闭标点不在行首）
      if (startsClose(R)) return false;
      // 两个成对标点（破折号/省略号）不可拆为两行（取两侧块边界字符）
      var lch = lastCp(L);
      var rch = firstCp(R);
      if (DASH_CHARS[lch] && DASH_CHARS[rch]) return false;
      if (lch === 0x2026 && rch === 0x2026) return false;
      return true;
    }

    var INF = Infinity;
    var cost = new Array(n + 1); // cost[i]：排好 tokens[0..i-1] 的最小代价
    var link = new Int32Array(n + 1);
    var linesEnding = new Int32Array(n + 1);
    for (var c = 0; c <= n; c++) { cost[c] = INF; link[c] = -1; }
    cost[0] = 0;
    linesEnding[0] = 0;

    for (var end = 1; end <= n; end++) {
      // 从 end-1 向左枚举起点 start，行内容为 tokens[start..end-1]。
      // 增量维护「可见宽度」：行首空格不计，两个可见 token 之间的空格计入。
      var lineWidth = 0;
      var seenVisible = false;   // 当前窗口中是否已遇到可见 token
      var pendingSpace = 0;      // 已遇到可见 token 之后、下一个可见 token 之前的空格宽
      var visEnd = end;          // 窗口内最后一个可见 token 下标
      for (var start = end - 1; start >= 0; start--) {
        var tok = tokens[start];
        if (tok.type === 'space') {
          if (seenVisible) pendingSpace += w[start];
        } else {
          if (!seenVisible) visEnd = start;
          lineWidth += w[start] + pendingSpace;
          pendingSpace = 0;
          seenVisible = true;
        }
        if (lineWidth > maxWidth + 0.5) break;
        if (!seenVisible) continue; // 窗口只有空格

        var visStart = start;
        while (tokens[visStart].type === 'space') visStart++;

        var isLastLine = (visEnd === n - 1);
        var slack = maxWidth - lineWidth;

        // 断点合法性：行尾可见 token 与下一段可见 token 之间
        var nextVis = nextNonSpace[visEnd];
        var prevVis = prevNonSpace[visStart];
        if (!canBreakBetween(visEnd, nextVis)) continue;
        if (start > 0 && prevVis >= 0) {
          if (!canBreakBetween(prevVis, visStart)) continue;
        }

        if (cost[start] === INF) continue;

        var edge = (isLastLine && lastLineFree) ? 0 : slack * slack;
        var cand = cost[start] + edge;
        var candLines = linesEnding[start] + 1;
        var better =
          cand < cost[end] ||
          (cand === cost[end] &&
            (candLines < linesEnding[end] ||
              (candLines === linesEnding[end] && link[end] < start)));
        if (better) {
          cost[end] = cand;
          link[end] = start;
          linesEnding[end] = candLines;
        }
      }
    }

    if (link[n] < 0 && n > 0) {
      return { lines: [], widths: [], tokens: [], overflows: [], infeasible: true };
    }

    // 回溯
    var ranges = [];
    var e = n;
    while (e > 0) {
      var s = link[e];
      ranges.push([s, e]);
      e = s;
    }
    ranges.reverse();

    var result = { lines: [], widths: [], tokens: [], overflows: [] };
    ranges.forEach(function (rg) {
      var seg = tokens.slice(rg[0], rg[1]);
      // 去掉行首行尾空格（已由断点规则保证不出现，这里兜底）
      var a = 0, b = seg.length;
      while (a < b && seg[a].type === 'space') a++;
      while (b > a && seg[b - 1].type === 'space') b--;
      seg = seg.slice(a, b);
      var lw = 0, seen = false;
      seg.forEach(function (tk) {
        if (tk.type === 'space') { if (seen) lw += measure(' '); }
        else { lw += measure(tk.t); seen = true; }
      });
      result.lines.push(seg.map(function (t) { return t.t; }).join(''));
      result.widths.push(lw);
      result.tokens.push(seg);
    });
    return result;
  }

  /**
   * 多段排版。最后一段的末行不计空白代价。
   * @param {string} text 原文
   * @param {number} maxWidth 行宽（px）
   * @param {(s:string)=>number} measure 文本宽度函数（px）
   * @param {string[]} [protectedWords] 中文专名保护词表（仅标题/中文正文传入）
   * @returns {{paragraphs:Array,totalLines:number,maxLineWidth:number}|
   *           {error:'width',overflows:Array}}
   */
  function planText(text, maxWidth, measure, protectedWords) {
    var paras = tokenize(text, protectedWords);
    var out = [];
    var totalLines = 0;
    var maxLineWidth = 0;
    var overflows = [];
    var seenOverflow = Object.create(null);
    var failed = false;
    for (var i = 0; i < paras.length; i++) {
      var r = planParagraph(
        paras[i], maxWidth, measure, i === paras.length - 1, protectedWords
      );
      if (r.overflows.length || r.infeasible) {
        failed = true;
        r.overflows.forEach(function (o) {
          var key = o.text + '|' + o.protect;
          if (!seenOverflow[key]) {
            seenOverflow[key] = true;
            overflows.push(o);
          }
        });
        continue; // 继续处理其余段落，尽量一次性列出全部超宽词
      }
      if (!failed) {
        out.push({ lines: r.lines, widths: r.widths, tokens: r.tokens });
        totalLines += r.lines.length;
        r.widths.forEach(function (wd) { if (wd > maxLineWidth) maxLineWidth = wd; });
      }
    }
    if (failed) return { error: 'width', overflows: overflows };
    return { paragraphs: out, totalLines: totalLines, maxLineWidth: maxLineWidth };
  }

  var api = {
    PX_PER_MM: PX_PER_MM,
    tokenize: tokenize,
    planParagraph: planParagraph,
    planText: planText,
    isWordCode: isWordCode,
    isCJKCode: isCJKCode
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LabelLayout = api;
})(typeof window !== 'undefined' ? window : globalThis);
