/*
 * accession.js —— 馆藏号对账（无 DOM 依赖，可在浏览器与 Node 中运行）
 *
 * 号码格式：「年份.批次.三位流水号」，如 2024.03.001；
 * 允许同前缀闭区间：2024.03.001-005 表示 2024.03.001 至 2024.03.005（含两端），
 * 展开时流水号保留三位宽度（001、002、……、005）。
 *
 * 解析拒绝（错误指出来源行）：
 *   - 格式错误：不是单个号码，也不是同前缀区间简写；
 *   - 区间倒序：起点流水号大于终点；
 *   - 任一侧（CSV / 登记清单）展开后超过 200 个号码。
 *
 * 对账（reconcile）按展开后的完整号码比较：
 *   - 两侧各自内部的重号（同一号码出现多次，含号段交叠），列出号码与全部来源行；
 *   - 仅在 CSV 出现的号码、仅在登记清单出现的号码，各附来源行；
 *   - 顺序不同不算差异：按号码集合比较，输出按号码升序排列。
 */
(function (global) {
  'use strict';

  var MAX_EXPAND = 200; // 任一侧展开后的号码总数上限

  // 单个号码：年份(4 位).批次(2 位).流水号(3 位)
  var RE_SINGLE = /^(\d{4})\.(\d{2})\.(\d{3})$/;
  // 同前缀闭区间：年份.批次.起点-终点（终点仅写三位流水号）
  var RE_RANGE = /^(\d{4})\.(\d{2})\.(\d{3})-(\d{3})$/;

  // 错误信息中录入内容的截断展示
  function brief(text) {
    var s = String(text == null ? '' : text);
    return s.length > 30 ? s.slice(0, 30) + '…' : s;
  }

  /**
   * 解析一个号码或同前缀闭区间。
   * @param {string} text 录入项（允许首尾空白）
   * @returns {{ok:true, prefix:string, start:number, end:number} |
   *           {ok:false, error:string}}
   *   prefix 含末尾点号（如 '2024.03.'），start/end 为流水号数值（闭区间）。
   */
  function parseItem(text) {
    var s = String(text == null ? '' : text).trim();
    var m = RE_SINGLE.exec(s);
    if (m) {
      return {
        ok: true,
        prefix: m[1] + '.' + m[2] + '.',
        start: parseInt(m[3], 10),
        end: parseInt(m[3], 10)
      };
    }
    m = RE_RANGE.exec(s);
    if (m) {
      var start = parseInt(m[3], 10);
      var end = parseInt(m[4], 10);
      if (start > end) {
        return {
          ok: false,
          error: '区间倒序：起点 ' + m[3] + ' 大于终点 ' + m[4] +
            '，请小号在前（如 ' + m[1] + '.' + m[2] + '.' + m[4] + '-' + m[3] + '）。'
        };
      }
      return { ok: true, prefix: m[1] + '.' + m[2] + '.', start: start, end: end };
    }
    return {
      ok: false,
      error: '格式错误：号码须为「年份.批次.三位流水号」（如 2024.03.001），' +
        '同前缀区间写作 2024.03.001-005。'
    };
  }

  // 流水号保留三位宽度
  function pad3(n) {
    return n < 10 ? '00' + n : (n < 100 ? '0' + n : String(n));
  }

  /**
   * 展开一侧的全部条目为完整号码列表。
   * @param {Array<{text:string, line:number}>} items 条目及来源行
   * @param {string} sideName 侧名（用于错误信息，如「CSV」「登记清单」）
   * @param {function(number):string} [lineLabel] 来源行格式化，默认「第 N 行」
   * @returns {{numbers:Array<{no:string, line:number}>, errors:string[]}}
   *   errors 非空即该侧不可用：格式错误/倒序逐项列出（含来源行）；
   *   展开超过 200 个号码时指出超限位置并停止展开。
   */
  function expandSide(items, sideName, lineLabel) {
    var label = lineLabel || function (line) { return '第 ' + line + ' 行'; };
    var numbers = [];
    var errors = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var parsed = parseItem(item.text);
      if (!parsed.ok) {
        errors.push(sideName + ' ' + label(item.line) + '「' + brief(item.text) +
          '」' + parsed.error);
        continue;
      }
      for (var n = parsed.start; n <= parsed.end; n++) {
        numbers.push({ no: parsed.prefix + pad3(n), line: item.line });
        if (numbers.length > MAX_EXPAND) {
          errors.push(sideName + ' 展开超过 ' + MAX_EXPAND + ' 个号码上限（展开到' +
            label(item.line) + '「' + brief(item.text) + '」时已超），请缩减号段后重试。');
          return { numbers: numbers, errors: errors };
        }
      }
    }
    return { numbers: numbers, errors: errors };
  }

  /**
   * 解析馆藏登记清单：每行一项（号码或同前缀区间），空行忽略，各项去首尾空白。
   * @param {string} raw 清单原文
   * @returns {{items:Array<{text:string, line:number}>}} line 为源文本行号（从 1 起）
   */
  function parseRegistry(raw) {
    var lines = String(raw == null ? '' : raw).split(/\r\n?|\n/);
    var items = [];
    for (var i = 0; i < lines.length; i++) {
      var text = lines[i].trim();
      if (text === '') continue; // 空行忽略
      items.push({ text: text, line: i + 1 });
    }
    return { items: items };
  }

  // 号码 → 来源行列表（按出现顺序，同一来源行不重复计入）
  function groupByNo(numbers) {
    var map = Object.create(null);
    for (var i = 0; i < numbers.length; i++) {
      var it = numbers[i];
      if (!map[it.no]) map[it.no] = [];
      if (map[it.no].indexOf(it.line) < 0) map[it.no].push(it.line);
    }
    return map;
  }

  function byNo(a, b) {
    return a.no < b.no ? -1 : (a.no > b.no ? 1 : 0);
  }

  // 一侧内部的重号：同一号码来源行数 > 1（含号段交叠），按号码升序
  function dupesOf(map) {
    var out = [];
    Object.keys(map).forEach(function (no) {
      if (map[no].length > 1) {
        out.push({ no: no, count: map[no].length, lines: map[no] });
      }
    });
    out.sort(byNo);
    return out;
  }

  /**
   * 对账：按展开后的完整号码比较两侧（顺序不同不算差异）。
   * @param {Array<{no:string, line:number}>} csvNumbers CSV 侧展开号码
   * @param {Array<{no:string, line:number}>} regNumbers 登记清单侧展开号码
   * @returns {{csvTotal:number, regTotal:number, csvUnique:number, regUnique:number,
   *            common:number,
   *            csvDupes:Array<{no:string, count:number, lines:number[]}>,
   *            regDupes:Array<{no:string, count:number, lines:number[]}>,
   *            onlyCsv:Array<{no:string, lines:number[]}>,
   *            onlyReg:Array<{no:string, lines:number[]}>}}
   *   各差异列表按号码升序；lines 为该号码的全部来源行。
   */
  function reconcile(csvNumbers, regNumbers) {
    var csvMap = groupByNo(csvNumbers);
    var regMap = groupByNo(regNumbers);

    var common = 0;
    var onlyCsv = [];
    Object.keys(csvMap).forEach(function (no) {
      if (regMap[no]) common++;
      else onlyCsv.push({ no: no, lines: csvMap[no] });
    });
    var onlyReg = [];
    Object.keys(regMap).forEach(function (no) {
      if (!csvMap[no]) onlyReg.push({ no: no, lines: regMap[no] });
    });
    onlyCsv.sort(byNo);
    onlyReg.sort(byNo);

    return {
      csvTotal: csvNumbers.length,
      regTotal: regNumbers.length,
      csvUnique: Object.keys(csvMap).length,
      regUnique: Object.keys(regMap).length,
      common: common,
      csvDupes: dupesOf(csvMap),
      regDupes: dupesOf(regMap),
      onlyCsv: onlyCsv,
      onlyReg: onlyReg
    };
  }

  var api = {
    MAX_EXPAND: MAX_EXPAND,
    parseItem: parseItem,
    expandSide: expandSide,
    parseRegistry: parseRegistry,
    reconcile: reconcile
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LabelAccession = api;
})(typeof window !== 'undefined' ? window : globalThis);
