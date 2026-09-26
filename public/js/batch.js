/*
 * batch.js —— 批量校样：CSV 解析与逐条校验（无 DOM 依赖，可在浏览器与 Node 中运行）
 *
 * CSV 格式（RFC 4180 子集）：
 *   - 首行为表头，须包含 title、zh、en 三列（列名去首尾空白、忽略大小写；
 *     顺序任意，允许额外列，额外列不参与校样）；
 *   - 字段可用英文双引号包裹：包裹字段内可含逗号与换行，两个连续双引号（""）
 *     转义为一个双引号；引号闭合后只允许空白、逗号、换行或文件尾；
 *   - 行结束符支持 \n、\r\n、\r；完全空白的行（无引号/逗号结构且仅含空白）忽略；
 *   - 数据记录最多 20 条（不含表头）。
 *
 * 逐条校验（错误定位到记录号，记录号从 1 起、不含表头）：
 *   - 列数须与表头列数一致；
 *   - 标题（title）与中文正文（zh）去首尾空白后必填；英文译文（en）可空。
 */
(function (global) {
  'use strict';

  var MAX_RECORDS = 20; // 数据记录条数上限（不含表头）

  /**
   * 解析 CSV 文本。
   * @param {string} text 原始 CSV 内容
   * @returns {{rows:Array<{cells:string[],line:number}>, errors:string[]}}
   *   rows 含表头行，line 为该记录在源文本中的起始行号（从 1 起，引号内换行计入）；
   *   errors 为解析级错误（含行号），非空时记录边界不可信，调用方应中止。
   */
  function parseCsv(text) {
    var src = String(text == null ? '' : text);
    if (src.charCodeAt(0) === 0xfeff) src = src.slice(1); // 去 BOM

    var rows = [];
    var errors = [];
    var cells = [];
    var field = '';
    var line = 1;           // 当前源文本行号（引号内换行同样递增）
    var recLine = 1;        // 当前记录的起始行号
    var hasStructure = false; // 当前记录是否含引号或逗号（用于忽略完全空白行）
    var state = 'start';    // start 字段起始 / plain 未包裹字段内 / quoted 引号内 / afterQ 引号闭合后

    function endField() {
      cells.push(field);
      field = '';
    }

    function endRecord() {
      endField();
      // 完全空白的行（无引号/逗号结构、唯一字段仅含空白）忽略，不计为记录
      if (!(cells.length === 1 && cells[0].trim() === '' && !hasStructure)) {
        rows.push({ cells: cells, line: recLine });
      }
      cells = [];
      hasStructure = false;
    }

    var i = 0;
    var n = src.length;
    while (i < n) {
      var ch = src[i];

      if (state === 'quoted') {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i += 2; continue; } // "" 转义为 "
          state = 'afterQ';
          i++;
          continue;
        }
        if (ch === '\n') {
          line++;
        } else if (ch === '\r') {
          line++;
          if (src[i + 1] === '\n') { field += '\r\n'; i += 2; continue; }
        }
        field += ch;
        i++;
        continue;
      }

      if (ch === ',') {
        endField();
        state = 'start';
        hasStructure = true;
        i++;
        continue;
      }
      if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        endRecord();
        state = 'start';
        line++;
        recLine = line;
        i++;
        continue;
      }

      if (state === 'start') {
        if (ch === '"') {
          state = 'quoted';
          hasStructure = true;
          i++;
          continue;
        }
        state = 'plain';
        field += ch;
        i++;
        continue;
      }

      if (state === 'afterQ') {
        // 引号闭合后允许空白直到逗号/换行/文件尾；其他字符为格式错误
        if (ch === ' ' || ch === '\t') { i++; continue; }
        errors.push('第 ' + line + ' 行：闭合引号后紧跟非法字符「' + ch +
          '」（只允许逗号、换行或文件尾）。');
        state = 'plain'; // 恢复：并入字段继续解析，便于一次性发现更多错误
        field += ch;
        i++;
        continue;
      }

      // plain：未包裹字段内的普通字符
      field += ch;
      i++;
    }

    if (state === 'quoted') {
      errors.push('第 ' + recLine + ' 行起的记录引号未闭合：' +
        '字段内的双引号需写成两个（""），请检查引号配对。');
    }
    // 文件尾：还有未结束的字段/记录时收尾
    if (field !== '' || cells.length > 0 || hasStructure || state === 'afterQ') {
      endRecord();
    }

    return { rows: rows, errors: errors };
  }

  /**
   * 解析并校验批量校样 CSV。
   * @param {string} text 原始 CSV 内容
   * @returns {{errors:string[],
   *            records:Array<{no:number,line:number,cells:string[],
   *                           title:string,zh:string,en:string,
   *                           valid:boolean,error:string|null}>,
   *            colIndex:Object<string,number>|null, colCount:number}}
   *   errors 为阻塞性整体错误（解析失败、表头缺列/重复、无记录、超过 20 条）；
   *   records 为数据记录（记录号 no 从 1 起），valid=false 时 error 给出原因；
   *   colIndex 为表头列名（去首尾空白、小写）到列号的映射，供取用 accession
   *   等额外列（表头校验失败时为 null）；colCount 为表头列数。
   */
  function buildBatch(text) {
    var result = { errors: [], records: [], colIndex: null, colCount: 0 };

    var parsed = parseCsv(text);
    if (parsed.errors.length) {
      result.errors = parsed.errors;
      return result;
    }
    if (!parsed.rows.length) {
      result.errors.push('请粘贴含表头 title,zh,en 的 CSV 内容。');
      return result;
    }

    // 表头：列名去首尾空白、忽略大小写；须含 title、zh、en，顺序任意，允许额外列
    var headerCells = parsed.rows[0].cells;
    var colIndex = Object.create(null);
    var dupCols = [];
    for (var hi = 0; hi < headerCells.length; hi++) {
      var name = headerCells[hi].trim().toLowerCase();
      if (!name) continue; // 空列名视为额外列，忽略
      if (colIndex[name] !== undefined) {
        if (dupCols.indexOf(name) < 0) dupCols.push(name);
        continue;
      }
      colIndex[name] = hi;
    }
    var required = ['title', 'zh', 'en'];
    var missing = [];
    for (var ri = 0; ri < required.length; ri++) {
      if (colIndex[required[ri]] === undefined) missing.push(required[ri]);
    }
    if (missing.length) {
      result.errors.push('表头缺少必需列：' + missing.join('、') +
        '（表头须包含 title,zh,en 三列，顺序任意，可含额外列）。');
      return result;
    }
    if (dupCols.length) {
      result.errors.push('表头存在重复列名：' + dupCols.join('、') + '，请去重后重试。');
      return result;
    }

    var colCount = headerCells.length;
    result.colIndex = colIndex;
    result.colCount = colCount;
    var dataRows = parsed.rows.slice(1);
    if (!dataRows.length) {
      result.errors.push('CSV 中没有数据记录：表头之后每行一条，至少 1 条、最多 ' +
        MAX_RECORDS + ' 条。');
      return result;
    }
    if (dataRows.length > MAX_RECORDS) {
      result.errors.push('数据记录共 ' + dataRows.length + ' 条，超过上限 ' +
        MAX_RECORDS + ' 条，请删减后重试。');
      return result;
    }

    for (var k = 0; k < dataRows.length; k++) {
      var row = dataRows[k];
      var rec = {
        no: k + 1,
        line: row.line,
        cells: row.cells,
        title: row.cells[colIndex.title] || '',
        zh: row.cells[colIndex.zh] || '',
        en: row.cells[colIndex.en] || '',
        valid: true,
        error: null
      };
      if (row.cells.length !== colCount) {
        rec.valid = false;
        rec.error = '列数不符：本记录 ' + row.cells.length + ' 列，表头 ' + colCount +
          ' 列；含逗号、换行或双引号的字段需用英文双引号整体包裹。';
      } else if (!rec.title.trim()) {
        rec.valid = false;
        rec.error = '缺少必填的标题（title 列）。';
      } else if (!rec.zh.trim()) {
        rec.valid = false;
        rec.error = '缺少必填的中文正文（zh 列）。';
      }
      result.records.push(rec);
    }
    return result;
  }

  var api = {
    MAX_RECORDS: MAX_RECORDS,
    parseCsv: parseCsv,
    buildBatch: buildBatch
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LabelBatch = api;
})(typeof window !== 'undefined' ? window : globalThis);
