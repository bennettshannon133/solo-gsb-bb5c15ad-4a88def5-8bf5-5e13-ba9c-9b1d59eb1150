/* app.js —— 交互、字宽测量、字号搜索、修订对照、渲染与打印 */
(function () {
  'use strict';

  var PX_PER_MM = window.LabelLayout.PX_PER_MM;
  var MIN_BODY = 12, MAX_BODY = 24;
  var TITLE_RATIO = 1.4;          // 标题字号 = 正文 × 1.4
  var PADDING_MM = 8;             // 展签内边距
  var COL_GAP_MM = 6;             // 双栏模式下中英两栏的栏间距
  var TITLE_LINE_HEIGHT = 1.3;
  var BODY_LINE_HEIGHT = 1.6;
  var TITLE_GAP_PX_FACTOR = 0.5;  // 标题与正文间距 = 0.5 个正文字号
  var PARA_GAP_PX_FACTOR = 0.6;   // 段间距 = 0.6 个正文字号
  var REV_LIMIT = 300;            // 修订稿字数上限（按 Unicode 字符计）
  var PROTECT_MAX = 20;           // 专名保护词数量上限
  var PROTECT_MAX_LEN = 12;       // 单个专名保护词的 Unicode 字符上限
  var QR_BAND_MM = 22;            // 底部为二维码固定留出的区域高度
  var QR_IMG_MM = 18;             // 二维码码图边长
  var QR_MIN_BLANK_MM = 2;        // 码图四周最少空白
  var QR_MAX_BYTES = 100;         // 链接 UTF-8 字节上限
  var SHEET_MARGIN_MM = 10;       // 拼版：纸张每边留白
  var SHEET_GAP_MM = 4;           // 拼版：相邻展签间隔
  var A4_W_MM = 210, A4_H_MM = 297; // A4 短边/长边
  var COPIES_MIN = 1, COPIES_MAX = 100; // 拼版份数范围
  var STOCK_MAX = 12;           // 库存规格选型：最多录入的规格种数（宽 30～999、高 20～999，同标签尺寸范围）

  var el = {
    title: document.getElementById('title'),
    body: document.getElementById('body'),
    bodyEn: document.getElementById('bodyEn'),
    paraAlign: document.getElementById('paraAlign'),
    paraAlignHint: document.getElementById('paraAlignHint'),
    glossary: document.getElementById('glossary'),
    glossaryHint: document.getElementById('glossaryHint'),
    termCheck: document.getElementById('termCheck'),
    termSummary: document.getElementById('termSummary'),
    termTable: document.getElementById('termTable'),
    termBody: document.getElementById('termBody'),
    qrLink: document.getElementById('qrLink'),
    qrHint: document.getElementById('qrHint'),
    bodyRev: document.getElementById('bodyRev'),
    revCount: document.getElementById('revCount'),
    protect: document.getElementById('protect'),
    protectHint: document.getElementById('protectHint'),
    widthMm: document.getElementById('widthMm'),
    heightMm: document.getElementById('heightMm'),
    stockSizes: document.getElementById('stockSizes'),
    stockHint: document.getElementById('stockHint'),
    stockPickBtn: document.getElementById('stockPickBtn'),
    stockResult: document.getElementById('stockResult'),
    batchCsv: document.getElementById('batchCsv'),
    batchHint: document.getElementById('batchHint'),
    batchRunBtn: document.getElementById('batchRunBtn'),
    batchResult: document.getElementById('batchResult'),
    accRegistry: document.getElementById('accRegistry'),
    accHint: document.getElementById('accHint'),
    accRunBtn: document.getElementById('accRunBtn'),
    accResult: document.getElementById('accResult'),
    printBtn: document.getElementById('printBtn'),
    status: document.getElementById('status'),
    stage: document.getElementById('stage'),
    label: document.getElementById('label'),
    labelError: document.getElementById('labelError'),
    compare: document.getElementById('compare'),
    diffView: document.getElementById('diffView'),
    diffStats: document.getElementById('diffStats'),
    fitBody: document.getElementById('fitBody'),
    fitDelta: document.getElementById('fitDelta'),
    finalOrig: document.getElementById('finalOrig'),
    finalRev: document.getElementById('finalRev'),
    copies: document.getElementById('copies'),
    orientPortrait: document.getElementById('orientPortrait'),
    orientLandscape: document.getElementById('orientLandscape'),
    sheetPrintBtn: document.getElementById('sheetPrintBtn'),
    sheetHint: document.getElementById('sheetHint'),
    sheetArea: document.getElementById('sheetArea'),
    sheetAreaSub: document.getElementById('sheetAreaSub'),
    sheets: document.getElementById('sheets'),
    sheetEmpty: document.getElementById('sheetEmpty'),
    batchSheetPrintBtn: document.getElementById('batchSheetPrintBtn'),
    batchSheetHint: document.getElementById('batchSheetHint'),
    batchSheetArea: document.getElementById('batchSheetArea'),
    batchSheetAreaSub: document.getElementById('batchSheetAreaSub'),
    batchSheets: document.getElementById('batchSheets'),
    batchSheetEmpty: document.getElementById('batchSheetEmpty')
  };

  // ---------- Canvas 实际字宽测量（按 font 分别缓存） ----------
  // 正文与标题（加粗、1.4×）字号不同：每 font 一个独立 context，
  // 避免交替调用互相改写 ctx.font；缓存也按 font 隔离，避免拼接 key 碰撞。
  var measurers = {};

  function makeMeasure(font) {
    if (!measurers[font]) {
      var context = document.createElement('canvas').getContext('2d');
      context.font = font;
      var cache = {};
      measurers[font] = function (text) {
        var v = cache[text];
        if (v === undefined) {
          v = context.measureText(text).width;
          cache[text] = v;
        }
        return v;
      };
    }
    return measurers[font];
  }

  function fontString(size, weight) {
    var family = '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", ' +
                 '"SimSun", "Times New Roman", serif';
    return (weight || 400) + ' ' + size + 'px ' + family;
  }

  // 一栏正文的渲染高度（px）：行高 + 段间距
  function columnHeight(plan, bodyPx) {
    if (!plan) return 0;
    var paraGaps = (plan.paragraphs.length - 1) * bodyPx * PARA_GAP_PX_FACTOR;
    return plan.totalLines * bodyPx * BODY_LINE_HEIGHT + paraGaps;
  }

  // 单段渲染高度（px）：仅行高，不含段间距
  function paragraphHeight(para, bodyPx) {
    return para.lines.length * bodyPx * BODY_LINE_HEIGHT;
  }

  // 非空段落数：与排版核心 tokenize 的分段结果一致（去首尾空白、合并连续空白后为空的段不计）
  function countParagraphs(text, protectedWords) {
    return window.LabelLayout.tokenize(text || '', protectedWords).length;
  }

  // ---------- 中文专名保护表解析 ----------
  // 每行一个词：空行忽略；重复词去重；含换行以外空白（含仅空白的行）报错；
  // 每个词 1～12 个 Unicode 字符；去重后最多 20 个。
  // 返回 { words: string[] } 或 { error: string }。
  function parseProtectedWords(raw) {
    var lines = String(raw == null ? '' : raw).split(/\r\n?|\n/);
    var words = [];
    var seen = Object.create(null);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === '') continue; // 空行忽略
      var cps = Array.from(line);
      var hasSpace = false;
      for (var k = 0; k < cps.length; k++) {
        if (isWhitespaceCp(cps[k].codePointAt(0))) { hasSpace = true; break; }
      }
      if (hasSpace) {
        return { error: '专名保护表第 ' + (i + 1) +
          ' 行含换行以外的空白字符（空格、制表符等），请删除或改为每行一个词。' };
      }
      if (cps.length < 1 || cps.length > PROTECT_MAX_LEN) {
        return { error: '专名保护表第 ' + (i + 1) + ' 行「' + line +
          '」长度为 ' + cps.length + ' 个字符，需为 1～' + PROTECT_MAX_LEN +
          ' 个 Unicode 字符。' };
      }
      if (!seen[line]) {
        seen[line] = true;
        words.push(line);
      }
    }
    if (words.length > PROTECT_MAX) {
      return { error: '专名保护表去重后有 ' + words.length +
        ' 个词，超过上限 ' + PROTECT_MAX + ' 个，请删减。' };
    }
    return { words: words };
  }

  // 换行（\n/\r，已按行切分）以外的 Unicode 空白
  function isWhitespaceCp(ch) {
    if (ch === 0x20 || ch === 0x09 || ch === 0x0b || ch === 0x0c ||
        ch === 0xa0 || ch === 0x1680 || ch === 0x2028 || ch === 0x2029 ||
        ch === 0x202f || ch === 0x205f || ch === 0x3000 || ch === 0xfeff) {
      return true;
    }
    return ch >= 0x2000 && ch <= 0x200a;
  }

  // ---------- 展品介绍链接校验 ----------
  // 空链接（或仅空白）→ null：不生成二维码，恢复原版式；
  // 合法 → { text, bytes }；非法 → { error }。
  // 规则：https:// 开头的完整链接、不含空白/控制字符、UTF-8 编码 ≤ 100 字节。
  function parseQrLink(raw) {
    var text = String(raw == null ? '' : raw).trim();
    if (!text) return null;
    if (/\s/.test(text)) {
      return { error: '链接中不能包含空格、换行等空白字符。' };
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(text)) {
      return { error: '链接中不能包含不可见的控制字符。' };
    }
    var url;
    try {
      url = new URL(text);
    } catch (e) {
      return { error: '链接格式无效：请输入完整链接，如 https://example.com/item/123 。' };
    }
    if (url.protocol !== 'https:') {
      return { error: '仅支持 https:// 开头的链接（当前为 ' +
        (url.protocol.replace(/:$/, '') || '未知协议') + '://）。' };
    }
    if (!url.hostname) {
      return { error: '链接缺少主机名，如 https://example.com/item/123 。' };
    }
    var bytes = window.LabelQR.byteLength(text);
    if (bytes > QR_MAX_BYTES) {
      return { error: '链接 UTF-8 编码后为 ' + bytes + ' 字节，超过 ' +
        QR_MAX_BYTES + ' 字节上限，请缩短链接。' };
    }
    return { text: text, bytes: bytes };
  }

  // ---------- 一次排版尝试 ----------
  // 单栏（无英文译文）：正文占满内容宽。
  // 双栏（填写译文）：标题横跨整签，中文/英文按扣除 6mm 栏间距后的实际栏宽
  //                  各自独立断行，共用同一个正文字号。
  // 双栏 + 段落对齐（input.paired）：中英正文先按换行拆成非空段落并按顺序一一配对；
  //                  段数不一致时直接失败（reason:'mismatch'）并指出两侧段数；
  //                  段数相等时每对仍按各自栏宽独立断行，但高度按「段对」核算——
  //                  每段对高度取中英两段较高者，段对之间沿用现有段间距，
  //                  下一段对因此在两栏同一高度起始。
  // 填写链接（input.reserveBottomMm = 22）：先从可用高度中扣除底部二维码区，
  //                  再按现有规则核算标题与正文。
  // 返回 { ok:true, ... } 或 { ok:false, reason: 'config'|'mismatch'|'width'|'height', ... }
  // 各种返回均带 zhLines / enLines（宽度/段数失败无法规划时为 null），
  // 供修订对照表展示两版行数。
  function tryLayout(input, widthMm, heightMm, bodyPx) {
    var reserveMm = input.reserveBottomMm || 0;
    var contentW = (widthMm - PADDING_MM * 2) * PX_PER_MM;
    var contentH = (heightMm - PADDING_MM * 2 - reserveMm) * PX_PER_MM;
    if (contentW <= 4 || contentH <= 4) {
      return {
        ok: false, reason: 'config',
        message: reserveMm > 0
          ? '标签尺寸过小：内边距 8mm 之外，底部还需固定留出 ' + QR_BAND_MM +
            'mm 二维码区；请加大宽或高，或清空链接恢复原版式。'
          : '标签尺寸过小：内边距为 8mm，请加大宽或高。'
      };
    }
    // 码图 18mm + 两侧各至少 2mm 空白：内容宽度不足时无法放置二维码
    if (reserveMm > 0 &&
        contentW < (QR_IMG_MM + QR_MIN_BLANK_MM * 2) * PX_PER_MM) {
      return {
        ok: false, reason: 'config',
        message: '标签宽度不足以放置二维码：' + QR_IMG_MM + 'mm 码图加两侧各 ' +
          QR_MIN_BLANK_MM + 'mm 空白共需约 ' + (QR_IMG_MM + QR_MIN_BLANK_MM * 2) +
          'mm 内容宽度（当前约 ' + Math.round(contentW / PX_PER_MM) +
          'mm）；请加宽标签或清空链接。'
      };
    }

    var dual = !!input.dual;
    var hasZh = !!input.bodyTrim;
    var hasEn = !!input.enTrim;

    var titlePx = Math.round(bodyPx * TITLE_RATIO * 100) / 100;
    var bodyMeasure = makeMeasure(fontString(bodyPx, 400));
    var titleMeasure = makeMeasure(fontString(titlePx, 700));

    // 栏宽：单栏占满；双栏扣除栏间距后平分
    var colW = dual
      ? (contentW - COL_GAP_MM * PX_PER_MM) / 2
      : contentW;
    if (colW <= 1) {
      var narrow = [];
      if (hasZh) narrow.push({ key: 'zh', widthMm: 0 });
      if (dual && hasEn) narrow.push({ key: 'en', widthMm: 0 });
      return {
        ok: false, reason: 'width', bodyPx: bodyPx, widthFailures: narrow,
        zhLines: null, enLines: null
      };
    }

    var paired = dual && !!input.paired;

    // 段落对齐：先按非空段落配对，两侧段数不等即指出差异并禁用成品打印。
    // 段数与字号无关，任何字号下都直接失败（computeLayout 立即返回）。
    if (paired) {
      var zhParaCount = hasZh
        ? countParagraphs(input.bodyTrim, input.protectedWords) : 0;
      var enParaCount = hasEn ? countParagraphs(input.enTrim) : 0;
      if (zhParaCount !== enParaCount) {
        return {
          ok: false, reason: 'mismatch', bodyPx: bodyPx,
          zhParaCount: zhParaCount, enParaCount: enParaCount,
          zhLines: null, enLines: null
        };
      }
    }

    // 标题横跨整签（两种模式均按内容全宽规划，允许折行）；标题与中文正文应用保护表
    var titlePlan = null;
    var titleWidthFail = false;
    var pw = input.protectedWords || [];
    if (input.titleTrim) {
      titlePlan = window.LabelLayout.planText(input.titleTrim, contentW, titleMeasure, pw);
      if (titlePlan.error) titleWidthFail = true;
    }

    var zhPlan = null, enPlan = null;
    var widthFailures = [];
    function collectFailures(key, plan, widthMm) {
      if (plan && plan.error === 'width') {
        widthFailures.push({ key: key, widthMm: widthMm, overflows: plan.overflows || [] });
      }
    }
    if (titleWidthFail) {
      collectFailures('title', titlePlan, contentW / PX_PER_MM);
    }
    if (hasZh) {
      zhPlan = window.LabelLayout.planText(input.bodyTrim, colW, bodyMeasure, pw);
      collectFailures('zh', zhPlan, colW / PX_PER_MM);
    }
    if (dual && hasEn) {
      // 英文译文不应用中文专名保护
      enPlan = window.LabelLayout.planText(input.enTrim, colW, bodyMeasure);
      collectFailures('en', enPlan, colW / PX_PER_MM);
    }

    if (widthFailures.length) {
      return {
        ok: false, reason: 'width', bodyPx: bodyPx, widthFailures: widthFailures,
        zhLines: zhPlan && !zhPlan.error ? zhPlan.totalLines : null,
        enLines: enPlan && !enPlan.error ? enPlan.totalLines : null
      };
    }

    // error 已被收集；此处仅为类型检查兜底
    titlePlan = titlePlan && !titlePlan.error ? titlePlan : null;
    zhPlan = zhPlan && !zhPlan.error ? zhPlan : null;
    enPlan = enPlan && !enPlan.error ? enPlan : null;

    if (!titlePlan && !zhPlan && !enPlan) {
      return {
        ok: true, dual: dual, paired: paired, pairCount: 0,
        titlePlan: null, zhPlan: null, enPlan: null,
        bodyPx: bodyPx, titlePx: titlePx, contentH: 0, colWMm: colW / PX_PER_MM,
        zhLines: 0, enLines: 0
      };
    }

    // 高度核算：标题（横跨整签）+ 标题间距 + 正文
    var titleH = 0, titleGap = 0;
    if (titlePlan) {
      titleH = titlePlan.totalLines * titlePx * TITLE_LINE_HEIGHT;
      if (zhPlan || enPlan) titleGap = bodyPx * TITLE_GAP_PX_FACTOR;
    }
    var zhH = columnHeight(zhPlan, bodyPx);
    var enH = columnHeight(enPlan, bodyPx);

    var pairHeights = null;
    var pairCount = 0;
    var bodyH;
    if (paired && zhPlan && enPlan &&
        zhPlan.paragraphs.length === enPlan.paragraphs.length) {
      // 段落对齐：每段对高度取双方较高者；段对之间沿用现有段间距。
      // 下一段对在两栏同一高度起始，两栏不再各排各的段间距。
      pairCount = zhPlan.paragraphs.length;
      pairHeights = [];
      bodyH = 0;
      for (var pi = 0; pi < pairCount; pi++) {
        var ph = Math.max(
          paragraphHeight(zhPlan.paragraphs[pi], bodyPx),
          paragraphHeight(enPlan.paragraphs[pi], bodyPx)
        );
        pairHeights.push(ph);
        bodyH += ph;
      }
      if (pairCount > 1) bodyH += (pairCount - 1) * bodyPx * PARA_GAP_PX_FACTOR;
    } else {
      // 独立双栏：高度按较高一栏（其内部段间距已计入 columnHeight）
      bodyH = Math.max(zhH, enH);
    }
    var totalH = titleH + titleGap + bodyH;

    if (totalH > contentH + 0.75) {
      return {
        ok: false, reason: 'height', bodyPx: bodyPx, paired: paired,
        pairCount: pairCount, pairHeights: pairHeights,
        totalH: totalH, contentH: contentH,
        zhH: zhH, enH: enH, titleH: titleH + titleGap,
        zhLines: zhPlan ? zhPlan.totalLines : 0,
        enLines: enPlan ? enPlan.totalLines : 0
      };
    }

    return {
      ok: true, dual: dual, paired: paired, pairCount: pairCount,
      pairHeights: pairHeights,
      titlePlan: titlePlan, zhPlan: zhPlan, enPlan: enPlan,
      bodyPx: bodyPx, titlePx: titlePx, contentH: totalH,
      zhH: zhH, enH: enH, colWMm: colW / PX_PER_MM,
      zhLines: zhPlan ? zhPlan.totalLines : 0,
      enLines: enPlan ? enPlan.totalLines : 0
    };
  }

  // ---------- 12→24 中选最大可行字号 ----------
  function computeLayout(input) {
    var lastHeightFailure = null;
    for (var px = MAX_BODY; px >= MIN_BODY; px--) {
      var r = tryLayout(input, input.widthMm, input.heightMm, px);
      if (r.ok) return r;
      if (r.reason === 'config') return r;     // 尺寸配置错误，与字号无关
      if (r.reason === 'mismatch') return r;   // 中英段数不等，与字号无关
      if (r.reason === 'width') {
        if (px === MIN_BODY) return r;         // 最小字号仍超宽，无法挽救
        continue;
      }
      if (r.reason === 'height') lastHeightFailure = r;
    }
    // 12px 仍超高
    return lastHeightFailure || {
      ok: false, reason: 'height', bodyPx: MIN_BODY, totalH: 0, contentH: 0
    };
  }

  // ---------- 错误文案 ----------
  var COL_NAMES = { title: '标题', zh: '中文原文栏', en: '英文译文栏' };

  function pxToMm(px) { return px / PX_PER_MM; }

  function widthFailureMessage(result, dual) {
    var parts = result.widthFailures.map(function (f) {
      var colLabel = f.key === 'title' ? '标题' : (dual ? COL_NAMES[f.key] : '正文');
      var widthText = Math.max(0, Math.round(f.widthMm)) + 'mm';
      // 标题按整签宽度；双栏按栏宽；单栏正文按行宽
      var spanName = f.key === 'title' ? '整签宽度' : (dual ? '栏宽' : '行宽');
      var protects = (f.overflows || []).filter(function (o) { return o.protect; });
      var others = (f.overflows || []).filter(function (o) { return !o.protect; });
      var items = [];

      if (protects.length) {
        items.push('保护词' + protects.map(function (o) {
          return '「' + o.text + '」需要约 ' +
            Math.round(pxToMm(o.width) * 10) / 10 + 'mm';
        }).join('、') + '，即使 ' + result.bodyPx +
          'px（最小字号）仍超出' + spanName + '（约 ' + widthText +
          '），不可拆词或截断');
      }
      if (others.length) {
        items.push('连续内容 ' + others.slice(0, 3).map(function (o) {
          return '「' + o.text + '」';
        }).join('、') + (others.length > 3 ? ' 等' : '') +
          '即使 ' + result.bodyPx + 'px（最小字号）也无法放入' +
          spanName + '（约 ' + widthText + '）');
      }
      if (!items.length) {
        items.push('存在即使 ' + result.bodyPx + 'px（最小字号）也无法放入' +
          spanName + '（约 ' + widthText + '）的连续内容');
      }
      return colLabel + items.join('；');
    });
    var head = dual ? '排不下（双栏）：' : '排不下：';
    return head + parts.join('；') + '。请加宽标签' +
      (dual ? '（加宽后两栏栏宽同步增加）' : '') +
      '、缩短保护词或修改文案——不会拆词、截断显示。';
  }

  function heightFailureMessage(result, dual, qrReserved) {
    var where = '';
    if (dual) {
      if (result.paired) {
        where = '（中英段落对齐，共 ' + (result.pairCount || 0) + ' 对段落，' +
          '按段对较高者累计）';
      } else if (result.enH > result.zhH) {
        where = '（英文译文栏较高）';
      } else if (result.zhH > 0) {
        where = '（中文原文栏较高）';
      }
    }
    var qrNote = qrReserved
      ? '（可用高度已先扣除底部 ' + QR_BAND_MM + 'mm 二维码区）'
      : '';
    return '内容在 12–24px 任何字号下都超出标签高度' + where + qrNote + '（需要约 ' +
      Math.round(result.totalH / PX_PER_MM) + 'mm，可用 ' +
      Math.round(result.contentH / PX_PER_MM) + 'mm）。\n' +
      '请加高标签或精简文案' +
      (qrReserved ? '，或清空链接恢复原版式' : '') +
      (result.paired ? '，或关闭「中英段落对齐」恢复两栏各自排版' : '') +
      '——不会截断显示。';
  }

  // 段落对齐模式下中英段数不一致：指出两侧段数差异并禁用打印
  function mismatchFailureMessage(result) {
    var diff = result.zhParaCount - result.enParaCount;
    var side = diff > 0 ? '中文原文' : '英文译文';
    return '中英段落对齐失败：中文正文有 ' + result.zhParaCount +
      ' 个非空段落，英文译文有 ' + result.enParaCount +
      ' 个，无法一一配对（' + side + '多 ' + Math.abs(diff) +
      ' 段）。请用回车把两侧段落数调整为一致，或关闭「中英段落对齐」开关；' +
      '段数一致前不生成预览成品，也不能打印。';
  }

  // ---------- 渲染 ----------
  function buildParagraphEl(para) {
    var p = document.createElement('div');
    p.className = 't-paragraph';
    para.lines.forEach(function (lineText) {
      var div = document.createElement('div');
      div.className = 't-line';
      div.textContent = lineText;
      p.appendChild(div);
    });
    return p;
  }

  function buildLines(container, plan) {
    container.innerHTML = '';
    plan.paragraphs.forEach(function (para) {
      container.appendChild(buildParagraphEl(para));
    });
  }

  // 段落对齐：段对按顺序依次写入同一 grid 容器（中文、英文、中文、英文……），
  // CSS grid 每行两列即一对，两列同高起始、行间距沿用 --para-gap。
  function buildPairedLines(container, zhPlan, enPlan) {
    container.innerHTML = '';
    var n = Math.min(zhPlan.paragraphs.length, enPlan.paragraphs.length);
    for (var i = 0; i < n; i++) {
      container.appendChild(buildParagraphEl(zhPlan.paragraphs[i]));
      container.appendChild(buildParagraphEl(enPlan.paragraphs[i]));
    }
  }

  var lastGood = null;
  var currentQr = null; // 当前生效的二维码（LabelQR.encode 结果）；null 表示不生成
  var lastSheets = null; // 当前可用的同款拼版方案；null 表示拼版不可用
  var batchImpose = null; // 校样生成的异款拼版素材（各记录自己的展签 DOM）；null 表示未生成/已失效
  var lastBatchSheets = null; // 当前可用的异款拼版分页；null 表示异款拼版不可打印
  var printMode = 'single'; // 本次打印输出：'single' 单张 / 'sheet' 同款拼版 / 'batch' 异款批量拼版

  // 把 QR 模块矩阵画到 canvas 上（白底黑块；显示尺寸由 CSS 固定为 18mm，
  // 码图之外的空白由底部 22mm 预留区与内边距保证；每张展签各自持有一个
  // canvas，按同一模块矩阵绘制，克隆或分页移动后码图一致）
  function drawQr(canvas, modules) {
    var size = modules.length;
    var scale = 8; // 内部分辨率：每模块 8×8 像素，18mm 下约 460DPI
    canvas.width = size * scale;
    canvas.height = size * scale;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (modules[y][x]) ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    }
  }

  // ---------- 展签成品 DOM 共用构建 ----------
  // 以排版结果、尺寸与二维码模块为唯一输入构建展签成品 DOM：
  // 单张预览（applyResult 填充 #label）、同款拼版的每份、异款拼版的
  // 每条记录都经同一流程生成，保证同一排版结果在三种打印方式下
  // 换行、字号与物理尺寸完全一致。

  // 把一次成功的排版结果写入给定 .label 元素：CSS 变量（毫米尺寸、字号、
  // 间距）、标题、单/双栏或段落对齐正文；填写链接时附加底部二维码区——
  // 每张展签持有自己的 canvas，按同一模块矩阵绘制
  function fillLabelElement(node, input, result, qr) {
    node.innerHTML = '';
    var s = node.style;
    s.setProperty('--label-w', input.widthMm + 'mm');
    s.setProperty('--label-h', input.heightMm + 'mm');
    s.setProperty('--body-size', result.bodyPx + 'px');
    s.setProperty('--title-size', result.titlePx + 'px');
    s.setProperty('--title-gap',
      result.titlePlan && (result.zhPlan || result.enPlan)
        ? (result.bodyPx * TITLE_GAP_PX_FACTOR) + 'px'
        : '0px');
    s.setProperty('--para-gap', result.bodyPx * PARA_GAP_PX_FACTOR + 'px');

    if (result.titlePlan) {
      var titleEl = document.createElement('div');
      titleEl.className = 'label-title';
      buildLines(titleEl, result.titlePlan);
      node.appendChild(titleEl);
    }

    if (result.paired && result.zhPlan && result.enPlan) {
      // 段落对齐成品：段对写入同一 grid 容器，两栏同高起始
      var pairedEl = document.createElement('div');
      pairedEl.className = 'label-content paired';
      buildPairedLines(pairedEl, result.zhPlan, result.enPlan);
      node.appendChild(pairedEl);
    } else {
      var content = document.createElement('div');
      content.className = 'label-content' + (result.dual ? ' dual' : '');
      var zhCol = document.createElement('div');
      zhCol.className = 'label-col';
      if (result.zhPlan) buildLines(zhCol, result.zhPlan);
      content.appendChild(zhCol);
      if (result.dual) {
        var enCol = document.createElement('div');
        enCol.className = 'label-col label-col-en';
        if (result.enPlan) buildLines(enCol, result.enPlan);
        content.appendChild(enCol);
      }
      node.appendChild(content);
    }

    // 二维码：每张展签按同一模块矩阵绘制自己的码图
    if (qr) {
      var qrBox = document.createElement('div');
      qrBox.className = 'label-qr';
      var canvas = document.createElement('canvas');
      drawQr(canvas, qr.modules);
      qrBox.appendChild(canvas);
      node.appendChild(qrBox);
    }
  }

  // 新建一张独立展签成品元素：同款拼版的每份与异款拼版的每条记录共用
  function buildLabelElement(input, result, qr) {
    var node = document.createElement('div');
    node.className = 'label sheet-label';
    fillLabelElement(node, input, result, qr);
    return node;
  }

  // 单张预览：同一构建流程填充 #label（保留元素本身以沿用缩放与打印样式），
  // 并挂回隐藏的错误占位；排版失败时由 showError 重新显示占位
  function applyResult(input, result) {
    fillLabelElement(el.label, input, result, currentQr);
    el.labelError.hidden = true;
    el.label.appendChild(el.labelError);
  }

  // 成功状态行文案
  function successInfo(input, result) {
    var reserveMm = input.reserveBottomMm || 0;
    var usedH = Math.round(result.contentH / PX_PER_MM);
    var info = '正文字号 ' + result.bodyPx + 'px（标题 ' +
      Math.round(result.titlePx * 10) / 10 + 'px）';
    if (result.dual) {
      info += '，双栏栏宽约 ' + Math.round(result.colWMm) + 'mm';
      if (result.paired) info += '，段落对齐 ' + result.pairCount + ' 对';
      if (result.zhPlan) info += '，中文 ' + result.zhPlan.totalLines + ' 行';
      if (result.enPlan) info += '，英文 ' + result.enPlan.totalLines + ' 行';
    } else if (result.zhPlan) {
      info += '，正文 ' + result.zhPlan.totalLines + ' 行';
    }
    if (result.titlePlan) info += '，标题 ' + result.titlePlan.totalLines + ' 行';
    info += '，内容高约 ' + usedH + 'mm / ' +
      Math.round(input.heightMm - PADDING_MM * 2 - reserveMm) + 'mm';
    if (reserveMm > 0) info += '（底部已预留 ' + QR_BAND_MM + 'mm 二维码区）';
    return info;
  }

  // 排版成功：预览与打印只呈现被选中的一版；
  // printBlock 为非空字符串时（如双语术语核对未通过），预览照常生成但禁用单张与拼版打印
  function showSuccess(input, result, versionName, printBlock) {
    lastGood = { input: input, result: result };
    applyResult(input, result);
    if (printBlock) {
      setStatus(printBlock, 'err');
      el.printBtn.disabled = true;
      fitScale();
      updateSheets(false, { hint: printBlock, sub: '拼版不可用：双语术语核对未通过' });
      return;
    }
    setStatus((versionName ? '成品：' + versionName + '　' : '') +
      successInfo(input, result), 'ok');
    el.printBtn.disabled = false;
    fitScale();
    updateSheets(true);
  }

  // 排版失败：说明超宽/超高并禁用打印；对照区在面板中保留，不受影响
  function showFailure(input, result, versionName) {
    var msg, tag = '';
    if (result.reason === 'config') {
      msg = result.message;
    } else if (result.reason === 'mismatch') {
      msg = mismatchFailureMessage(result);
      tag = '段数不一致';
    } else if (result.reason === 'width') {
      msg = widthFailureMessage(result, input.dual);
      tag = '超宽';
    } else {
      msg = heightFailureMessage(result, input.dual, (input.reserveBottomMm || 0) > 0);
      tag = '超高';
    }
    var prefix = versionName
      ? '【' + versionName + (tag ? ' · ' + tag : '') + '】'
      : '';
    setStatus(prefix + msg, 'err');
    showError(prefix + (result.reason === 'config' ? '标签尺寸过小\n' + msg : msg));
    el.printBtn.disabled = true;
    fitScale();
    updateSheets(false);
  }

  // ---------- 修订对照 ----------
  // 对照基于排版实际使用的文本（去首尾空白后的原稿与修订稿），
  // 换行统一为 \n 后按 Unicode 字符求最短增删对齐。
  function renderDiff(a, b) {
    var norm = function (s) { return String(s).replace(/\r\n?/g, '\n'); };
    var res = window.LabelDiff.align(norm(a), norm(b));
    el.diffView.innerHTML = '';
    if (!res.inserted && !res.deleted) {
      el.diffView.textContent = '修订稿与原稿完全一致，无差异。';
      el.diffStats.textContent = '';
      return;
    }
    res.segments.forEach(function (seg) {
      var node;
      if (seg.type === 'del') node = document.createElement('del');
      else if (seg.type === 'ins') node = document.createElement('ins');
      else node = document.createElement('span');
      appendSegText(node, seg.text, seg.type);
      el.diffView.appendChild(node);
    });
    el.diffStats.textContent =
      '新增 ' + res.inserted + ' 字 · 删除 ' + res.deleted + ' 字 · 相同 ' + res.kept + ' 字';
  }

  // 片段文本写入节点；换行在新增/删除片段中以 ↵ 标记显式标出
  function appendSegText(node, text, type) {
    var parts = text.split('\n');
    for (var i = 0; i < parts.length; i++) {
      if (i > 0) {
        if (type !== 'keep') {
          var mark = document.createElement('i');
          mark.className = 'nl';
          mark.textContent = '↵';
          node.appendChild(mark);
        }
        node.appendChild(document.createElement('br'));
      }
      if (parts[i]) node.appendChild(document.createTextNode(parts[i]));
    }
  }

  // 单版能否容纳的对照表文案
  function fitNote(r) {
    if (r.ok) return { text: '✓ 可容纳', bad: false };
    if (r.reason === 'width') {
      var protects = (r.widthFailures || []).reduce(function (acc, f) {
        return acc.concat((f.overflows || []).filter(function (o) { return o.protect; }));
      }, []);
      if (protects.length) {
        return {
          text: '✗ 超宽：保护词「' + protects[0].text + '」12px 仍需约 ' +
            Math.round(pxToMm(protects[0].width) * 10) / 10 + 'mm',
          bad: true
        };
      }
      return { text: '✗ 超宽：12px 仍放不进行宽', bad: true };
    }
    if (r.reason === 'height') {
      return {
        text: '✗ 超高：12px 需约 ' + Math.round(r.totalH / PX_PER_MM) +
          'mm / 可用 ' + Math.round(r.contentH / PX_PER_MM) + 'mm',
        bad: true
      };
    }
    if (r.reason === 'mismatch') {
      return {
        text: '✗ 段数不一致：中文 ' + r.zhParaCount + ' 段 / 英文 ' +
          r.enParaCount + ' 段，禁印',
        bad: true
      };
    }
    return { text: '✗ ' + (r.message || '尺寸无效'), bad: true };
  }

  function verBrief(r) {
    if (r.ok) return r.bodyPx + 'px 可容纳';
    if (r.reason === 'width') return '超宽排不下';
    if (r.reason === 'height') return '超高排不下';
    if (r.reason === 'mismatch') {
      return '中英段数不一致（' + r.zhParaCount + ' / ' + r.enParaCount + '）';
    }
    return '尺寸无效';
  }

  // 两版对比表 + 变化摘要
  function renderFit(resOrig, resRev) {
    el.fitBody.innerHTML = '';
    [['原稿', resOrig], ['修订稿', resRev]].forEach(function (row) {
      var name = row[0], r = row[1];
      var note = fitNote(r);
      var tr = document.createElement('tr');
      [name,
       r.ok ? r.bodyPx + 'px' : '—',
       r.zhLines == null ? '—' : r.zhLines + ' 行',
       note.text].forEach(function (txt, idx) {
        var td = document.createElement('td');
        td.textContent = txt;
        if (idx === 3) td.className = note.bad ? 'bad' : 'good';
        tr.appendChild(td);
      });
      el.fitBody.appendChild(tr);
    });

    var delta;
    if (resOrig.ok && resRev.ok) {
      var fs = resOrig.bodyPx === resRev.bodyPx
        ? '字号同为 ' + resOrig.bodyPx + 'px'
        : '字号 ' + resOrig.bodyPx + 'px → ' + resRev.bodyPx + 'px';
      var ln = resOrig.zhLines === resRev.zhLines
        ? '中文行数同为 ' + resOrig.zhLines + ' 行'
        : '中文行数 ' + resOrig.zhLines + ' → ' + resRev.zhLines + ' 行';
      delta = '变化：' + fs + '，' + ln + '；两版均可容纳。';
    } else {
      delta = '变化：原稿 ' + verBrief(resOrig) +
        ' → 修订稿 ' + verBrief(resRev) + '。';
    }
    el.fitDelta.textContent = delta;
  }

  // ---------- 双语术语核对 ----------
  // 对照表每行「中文术语=英文译名」（解析与逐行校验见 terms.js）。
  // 仅在「中英段落对齐」开启且中英段数一致时，对当前选定成品（原稿或修订稿）
  // 逐段比较同一术语两侧出现次数；次数不符时列出段号、术语及两侧次数，
  // 并禁用单张与拼版打印（对照表无效同样禁用），修正后自动恢复。
  function termNote(text, kind) {
    el.termSummary.textContent = text;
    el.termSummary.className = 'term-summary' + (kind ? ' ' + kind : '');
  }

  // 刷新术语核对区；返回 null（不阻塞打印）或阻塞打印的提示文案
  function updateTermCheck(c, entries) {
    if (!entries.length) {
      el.termCheck.hidden = true;
      return null;
    }
    el.termCheck.hidden = false;
    el.termTable.hidden = true;
    el.termBody.innerHTML = '';

    var input = c.input;
    if (!input.dual) {
      termNote('已录入 ' + entries.length +
        ' 对术语；填写英文译文进入双栏并开启「中英段落对齐」后，逐段核对两侧次数。');
      return null;
    }
    if (!input.paired) {
      termNote('已录入 ' + entries.length +
        ' 对术语；开启「中英段落对齐」且中英段数一致后，逐段核对两侧次数。');
      return null;
    }

    // 对当前选定成品版本的中文正文与共用的英文译文逐段核对
    var useRev = c.revActive && selectedVersion === 'rev';
    var zhText = useRev ? c.revTrim : input.bodyTrim;
    var verName = useRev ? '修订稿' : '原稿';
    var res = window.LabelTerms.checkParagraphs(zhText, input.enTrim, entries);

    if (res.zhParas !== res.enParas) {
      // 段数不一致时排版本身已判定失败并禁印，这里只说明核对未执行
      termNote('成品：' + verName + ' · 中文 ' + res.zhParas + ' 段、英文 ' +
        res.enParas + ' 段，段数不一致，无法逐段核对；请调整回车分段。', 'err');
      return null;
    }

    if (!res.mismatches.length) {
      termNote('成品：' + verName + ' · ' + res.pairs + ' 对段落 × ' +
        entries.length + ' 个术语，两侧出现次数全部一致。', 'ok');
      return null;
    }

    res.mismatches.forEach(function (m) {
      var tr = document.createElement('tr');
      ['第 ' + m.para + ' 段', m.zh, m.en, m.zhCount + ' 次', m.enCount + ' 次']
        .forEach(function (txt, idx) {
          var td = document.createElement('td');
          td.textContent = txt;
          if (idx >= 3) td.className = 'bad';
          tr.appendChild(td);
        });
      el.termBody.appendChild(tr);
    });
    el.termTable.hidden = false;
    termNote('成品：' + verName + ' · ' + res.mismatches.length +
      ' 处术语次数不符（段号、术语及两侧次数见下表）；' +
      '修正对照表或正文/译文后自动恢复打印。', 'err');
    return '双语术语核对未通过：' + res.mismatches.length +
      ' 处术语次数不符（详见「双语术语核对」区），已禁用单张与拼版打印。';
  }

  // ---------- 输入收集 ----------
  // 收集当前面板输入并构造排版输入（原稿与修订稿两版），主渲染与库存规格选型共用。
  // 返回 { input, revInput, revTrim, revActive, qr, qrError, qrParsed, protect }；
  // qrError / protect.error 为阻塞性错误，调用方据此中断后续排版。
  function collectInputs() {
    var input = {
      title: el.title.value,
      body: el.body.value,
      bodyEn: el.bodyEn.value,
      widthMm: parseFloat(el.widthMm.value),
      heightMm: parseFloat(el.heightMm.value)
    };
    input.titleTrim = input.title.trim();
    input.bodyTrim = input.body.trim();
    input.enTrim = input.bodyEn.trim();
    input.dual = input.enTrim.length > 0;
    input.paired = input.dual && el.paraAlign.checked;

    // 展品介绍链接 → 底部二维码；非法或无法编码时报错，空链接不预留底部区域
    var qrParsed = parseQrLink(el.qrLink.value);
    var qrError = qrParsed && qrParsed.error ? qrParsed.error : null;
    var qr = null;
    if (!qrError && qrParsed) {
      var qrEnc = window.LabelQR.encode(qrParsed.text);
      if (qrEnc.error) {
        qrError = '链接无法编码为二维码：数据超出 QR 版本 ' +
          window.LabelQR.MAX_VERSION + '（纠错 M）约 ' + qrEnc.maxBytes +
          ' 字节的容量上限。';
      } else {
        qr = qrEnc;
      }
    }
    input.reserveBottomMm = qr ? QR_BAND_MM : 0;

    // 中文专名保护表：原稿与修订稿应用同一张表
    var protect = parseProtectedWords(el.protect.value);
    if (!protect.error) input.protectedWords = protect.words;

    // 修订稿非空白即进入对照模式；修订稿沿用当前尺寸与英文译文
    var revTrim = el.bodyRev.value.trim();
    var revActive = revTrim.length > 0;
    var revInput = null;
    if (revActive) {
      revInput = {
        title: input.title,
        body: el.bodyRev.value,
        bodyEn: input.bodyEn,
        widthMm: input.widthMm,
        heightMm: input.heightMm,
        protectedWords: input.protectedWords,
        reserveBottomMm: input.reserveBottomMm,
        paired: input.paired
      };
      revInput.titleTrim = input.titleTrim;
      revInput.bodyTrim = revTrim;
      revInput.enTrim = input.enTrim;
      revInput.dual = input.dual;
    }

    return {
      input: input, revInput: revInput, revTrim: revTrim, revActive: revActive,
      qr: qr, qrError: qrError, qrParsed: qrParsed, protect: protect
    };
  }

  function render() {
    var c = collectInputs();
    var input = c.input;

    // 段落对齐开关仅在中英双栏时可用；单栏时恢复现有独立布局
    el.paraAlign.disabled = !input.dual;
    el.paraAlignHint.textContent = !input.dual
      ? '填写英文译文进入双栏后可用'
      : (input.paired
          ? '已开启：中英段落一一配对、同高起始'
          : '已关闭：两栏按各自内容独立排版');

    currentQr = c.qr;
    el.qrHint.classList.toggle('err', !!c.qrError);
    if (c.qrError) {
      el.qrHint.textContent = c.qrError;
      setStatus(c.qrError, 'err');
      showError('展品介绍链接有误\n' + c.qrError);
      el.printBtn.disabled = true;
      fitScale();
      updateSheets(false);
      return;
    }
    el.qrHint.textContent = currentQr
      ? '已生成二维码：' + c.qrParsed.bytes + ' / ' + QR_MAX_BYTES +
        ' 字节（版本 V' + currentQr.version + '，浏览器本地生成）'
      : '未填写链接，不生成二维码';

    // 中文专名保护表：非法时禁用打印、不进行排版
    el.protectHint.classList.toggle('err', !!c.protect.error);
    if (c.protect.error) {
      el.protectHint.textContent = c.protect.error;
      setStatus(c.protect.error, 'err');
      showError('专名保护表有误\n' + c.protect.error);
      el.printBtn.disabled = true;
      fitScale();
      updateSheets(false);
      return;
    }
    var dupCount = countNonEmptyLines(el.protect.value) - input.protectedWords.length;
    el.protectHint.textContent = input.protectedWords.length
      ? '已启用 ' + input.protectedWords.length + ' 个保护词' +
        (dupCount > 0 ? '（已自动忽略 ' + dupCount + ' 个重复词）' : '')
      : '未设置保护词';

    // 双语术语对照表：空行忽略；重复中文项、空值或格式错误逐行提示，
    // 存在任一错误即对照表无效——禁用单张与拼版打印，修正后恢复
    var glossary = window.LabelTerms.parseGlossary(el.glossary.value);
    el.glossaryHint.classList.toggle('err', glossary.errors.length > 0);
    if (glossary.errors.length) {
      el.glossaryHint.textContent = glossary.errors.join('\n');
      el.termCheck.hidden = true;
      setStatus('双语术语对照表有误：\n' + glossary.errors.join('\n'), 'err');
      showError('双语术语对照表有误\n' + glossary.errors.join('\n'));
      el.printBtn.disabled = true;
      fitScale();
      updateSheets(false, {
        hint: '双语术语对照表有误，修正前拼版打印不可用。',
        sub: '拼版不可用：术语对照表有误'
      });
      return;
    }
    el.glossaryHint.textContent = glossary.entries.length
      ? '已录入 ' + glossary.entries.length + ' 对术语'
      : '未录入术语对照';

    // 修订稿非空白即进入对照模式；新填写修订稿时默认以修订稿为成品
    var revActive = c.revActive;
    if (revActive && !revWasActive) selectedVersion = 'rev';
    if (!revActive) selectedVersion = 'orig';
    revWasActive = revActive;
    el.finalOrig.checked = selectedVersion === 'orig';
    el.finalRev.checked = selectedVersion === 'rev';
    el.compare.hidden = !revActive;

    // 差异对照与尺寸无关，先行渲染（尺寸非法期间对照仍保持更新）
    if (revActive) renderDiff(input.bodyTrim, c.revTrim);

    // 双语术语核对：编辑正文/译文/对照表或切换成品版本后随本次渲染刷新；
    // 仅在段落对齐开启且中英段数一致时逐段核对，次数不符则阻塞打印
    var termBlock = updateTermCheck(c, glossary.entries);

    if (!(input.widthMm >= 30 && input.widthMm <= 999 &&
          input.heightMm >= 20 && input.heightMm <= 999)) {
      setStatus('请输入有效的标签尺寸：宽 30–999mm，高 20–999mm。', 'err');
      showError('标签尺寸无效\n（宽 30–999mm，高 20–999mm）');
      el.printBtn.disabled = true;
      updateSheets(false);
      return;
    }

    if (!revActive) {
      var single = computeLayout(input);
      if (!single.ok) showFailure(input, single, null);
      else showSuccess(input, single, null, termBlock);
      return;
    }

    // 对照模式：原稿与修订稿沿用当前尺寸与英文译文，分别运行现有排版，共用同一保护表
    var resOrig = computeLayout(input);
    var resRev = computeLayout(c.revInput);
    renderFit(resOrig, resRev);

    if (selectedVersion === 'rev') {
      if (!resRev.ok) showFailure(c.revInput, resRev, '修订稿');
      else showSuccess(c.revInput, resRev, '修订稿', termBlock);
    } else {
      if (!resOrig.ok) showFailure(input, resOrig, '原稿');
      else showSuccess(input, resOrig, '原稿', termBlock);
    }
  }

  // 保护表中非空行数（用于提示去重数量）
  function countNonEmptyLines(raw) {
    return String(raw == null ? '' : raw)
      .split(/\r\n?|\n/)
      .filter(function (ln) { return ln !== ''; }).length;
  }

  // ---------- 库存规格选型 ----------
  // 解析库存规格表：每行「宽×高」（毫米；分隔符 ×/x/X/* 均可，数字两侧可含空白）。
  // 空行忽略；重复规格（宽与高均相同）去重，保留首次出现的顺序；
  // 非法行记录行号与原因，不参与推荐；去重后超过 12 种时给出错误（不选型）。
  // 返回 { sizes: [{w, h, order}], errors: [string], dups: number, error: string|null }
  function parseStockSizes(raw) {
    var lines = String(raw == null ? '' : raw).split(/\r\n?|\n/);
    var sizes = [];
    var errors = [];
    var dups = 0;
    var seen = Object.create(null);
    for (var i = 0; i < lines.length; i++) {
      var text = lines[i].trim();
      if (text === '') continue; // 空行忽略
      var m = text.match(/^(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)$/);
      if (!m) {
        errors.push('第 ' + (i + 1) + ' 行「' + text +
          '」无法识别：请按「宽×高」填写（毫米），如 120×80。');
        continue;
      }
      var w = parseFloat(m[1]);
      var h = parseFloat(m[2]);
      if (!(w >= 30 && w <= 999)) {
        errors.push('第 ' + (i + 1) + ' 行宽 ' + m[1] +
          'mm 超出范围（宽需 30～999mm），该行不参与推荐。');
        continue;
      }
      if (!(h >= 20 && h <= 999)) {
        errors.push('第 ' + (i + 1) + ' 行高 ' + m[2] +
          'mm 超出范围（高需 20～999mm），该行不参与推荐。');
        continue;
      }
      var key = w + '×' + h;
      if (seen[key]) { dups++; continue; } // 重复规格去重
      seen[key] = true;
      sizes.push({ w: w, h: h, order: sizes.length });
    }
    var error = null;
    if (sizes.length > STOCK_MAX) {
      error = '库存规格去重后有 ' + sizes.length + ' 种，超过上限 ' + STOCK_MAX +
        ' 种，请删减后再选型。';
    }
    return { sizes: sizes, errors: errors, dups: dups, error: error };
  }

  // 库存规格表提示：录入种数、重复与非法行（指出行号）；仅更新提示，不参与排版
  function updateStockHint() {
    var parsed = parseStockSizes(el.stockSizes.value);
    var parts = [];
    if (parsed.sizes.length) {
      parts.push('已录入 ' + parsed.sizes.length + ' 种规格' +
        (parsed.dups ? '（已自动忽略 ' + parsed.dups + ' 个重复规格）' : ''));
    } else {
      parts.push('未录入库存规格');
    }
    if (parsed.errors.length) parts.push(parsed.errors.join(' '));
    if (parsed.error) parts.push(parsed.error);
    el.stockHint.textContent = parts.join(' ');
    el.stockHint.classList.toggle('err', parsed.errors.length > 0 || !!parsed.error);
  }

  // 选型结果中单个规格的失败原因（沿用对照表 fitNote 的口径；
  // 尺寸配置失败换为简短说明，完整原因可在手动填入该尺寸后于预览区查看）
  function stockFailNote(r, qrReserved) {
    if (r.reason === 'config') {
      return '✗ 尺寸过小：扣除 8mm 内边距' +
        (qrReserved ? '与底部 ' + QR_BAND_MM + 'mm 二维码区' : '') +
        '后无足够排版空间';
    }
    return fitNote(r).text;
  }

  function showStockError(message) {
    el.stockResult.innerHTML = '';
    var div = document.createElement('div');
    div.className = 'stock-result-none';
    div.textContent = message;
    el.stockResult.appendChild(div);
    el.stockResult.hidden = false;
  }

  // 点击「选型」：以当前选定的成品版本（原稿/修订稿）与当前中英、段落对齐、
  // 专名保护、二维码设置，对每种库存规格调用现有排版规则求最大可用字号。
  function runStockPick() {
    var parsed = parseStockSizes(el.stockSizes.value);
    updateStockHint();

    if (parsed.error) { showStockError(parsed.error); return; }
    if (!parsed.sizes.length) {
      showStockError('没有可参与推荐的库存规格：请逐行录入现有展签的「宽×高」（毫米）。' +
        (parsed.errors.length ? '\n' + parsed.errors.join('\n') : ''));
      return;
    }

    // 当前设置存在阻塞性错误（链接/保护表）时不选型
    var c = collectInputs();
    if (c.qrError) {
      showStockError('展品介绍链接有误，无法选型：\n' + c.qrError);
      return;
    }
    if (c.protect.error) {
      showStockError('专名保护表有误，无法选型：\n' + c.protect.error);
      return;
    }

    var useRev = c.revActive && selectedVersion === 'rev';
    var base = useRev ? c.revInput : c.input;

    var rows = parsed.sizes.map(function (s) {
      var trial = Object.assign({}, base, { widthMm: s.w, heightMm: s.h });
      return {
        w: s.w, h: s.h, order: s.order, area: s.w * s.h,
        result: computeLayout(trial)
      };
    });
    // 面积从小到大，同面积按录入顺序
    var byArea = function (a, b) { return a.area - b.area || a.order - b.order; };
    var fitting = rows.filter(function (r) { return r.result.ok; }).sort(byArea);
    var failing = rows.filter(function (r) { return !r.result.ok; }).sort(byArea);

    renderStockResult(c, useRev, fitting, failing, parsed.errors);
  }

  // 选型结果：能完整容纳的规格按面积从小到大（同面积按录入顺序）列在前，
  // 其余规格列在后并注明失败原因；每个可容纳规格提供「采用」按钮。
  function renderStockResult(c, useRev, fitting, failing, lineErrors) {
    el.stockResult.innerHTML = '';
    el.stockResult.hidden = false;

    var basis = '成品＝' + (useRev ? '修订稿' : '原稿') +
      ' · ' + (c.input.dual ? '中英双栏' : '单栏') +
      (c.input.paired ? ' · 段落对齐' : '') +
      (c.input.protectedWords && c.input.protectedWords.length
        ? ' · 保护词 ' + c.input.protectedWords.length + ' 个' : '') +
      (c.qr ? ' · 预留 ' + QR_BAND_MM + 'mm 二维码区' : ' · 无二维码');
    var head = document.createElement('div');
    head.className = 'stock-result-head';
    head.textContent = '选型依据：' + basis + '。修改文案或设置后请重新点击「选型」。';
    el.stockResult.appendChild(head);

    if (lineErrors.length) {
      var errs = document.createElement('div');
      errs.className = 'stock-result-errs';
      errs.textContent = '以下行无效，未参与推荐：\n' + lineErrors.join('\n');
      el.stockResult.appendChild(errs);
    }

    if (!fitting.length) {
      var none = document.createElement('div');
      none.className = 'stock-result-none';
      none.textContent = '没有能完整容纳当前成品的库存规格；当前尺寸保持不变，未做改动。';
      el.stockResult.appendChild(none);
    }

    var table = document.createElement('table');
    table.className = 'stock-table';
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    ['规格（宽×高，mm）', fitting.length ? '可用字号 / 失败原因' : '失败原因', '操作']
      .forEach(function (txt) {
        var th = document.createElement('th');
        th.textContent = txt;
        headRow.appendChild(th);
      });
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');

    fitting.forEach(function (row, idx) {
      var tr = document.createElement('tr');
      var sizeTd = document.createElement('td');
      sizeTd.textContent = row.w + ' × ' + row.h;
      if (idx === 0) {
        var best = document.createElement('span');
        best.className = 'stock-best';
        best.textContent = '推荐';
        sizeTd.appendChild(best);
      }
      var resTd = document.createElement('td');
      resTd.className = 'good';
      resTd.textContent = '✓ 可用 ' + row.result.bodyPx + 'px';
      var actTd = document.createElement('td');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'stock-adopt';
      btn.textContent = '采用';
      btn.addEventListener('click', function () { adoptStockSize(row.w, row.h); });
      actTd.appendChild(btn);
      tr.appendChild(sizeTd);
      tr.appendChild(resTd);
      tr.appendChild(actTd);
      tbody.appendChild(tr);
    });

    failing.forEach(function (row) {
      var tr = document.createElement('tr');
      var sizeTd = document.createElement('td');
      sizeTd.textContent = row.w + ' × ' + row.h;
      var resTd = document.createElement('td');
      resTd.className = 'bad';
      resTd.textContent = stockFailNote(row.result, !!c.qr);
      var actTd = document.createElement('td');
      actTd.textContent = '—';
      tr.appendChild(sizeTd);
      tr.appendChild(resTd);
      tr.appendChild(actTd);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    el.stockResult.appendChild(table);

    if (fitting.length) {
      var tip = document.createElement('div');
      tip.className = 'stock-result-head';
      tip.textContent = '点击「采用」才把该规格回填到宽/高并刷新预览、单张与拼版打印；未采用前当前尺寸不变。';
      el.stockResult.appendChild(tip);
    }
  }

  // 采用推荐规格：回填宽/高并重排，刷新原有预览、单张及拼版打印
  function adoptStockSize(w, h) {
    el.widthMm.value = w;
    el.heightMm.value = h;
    invalidateBatchSheets('展签尺寸已修改：异款拼版已失效，请重新点击「开始校样」按新尺寸生成。');
    render();
  }

  // ---------- 批量校样 ----------
  // 粘贴含表头 title,zh,en 的 CSV（解析与逐条校验见 batch.js，错误定位到记录号）：
  // 每条记录仅替换标题、中文正文与英文译文，沿用当前尺寸、段落对齐开关、
  // 专名保护表、二维码与术语对照表设置，调用同一套排版与打印门禁逐条试排；
  // 校样只读当前设置、不改动任何面板输入，当前成品保持不变；
  // 点击通过记录的「载入编辑」才回填三栏并清空修订稿，随后由原有预览与打印流程处理。

  // CSV 输入提示：实时解析并汇总记录数与逐条校验错误（不排版、不改变成品）
  function updateBatchHint() {
    el.batchResult.hidden = true;
    invalidateBatchSheets('CSV 内容已修改：异款拼版已失效，请重新点击「开始校样」生成。');
    clearAccessionResult(); // CSV 变化后旧对账结果失效
    var raw = el.batchCsv.value;
    el.batchHint.classList.remove('err');
    if (!String(raw).trim()) {
      el.batchHint.textContent = '未粘贴 CSV';
      return;
    }
    var batch = window.LabelBatch.buildBatch(raw);
    if (batch.errors.length) {
      el.batchHint.textContent = batch.errors.join('\n');
      el.batchHint.classList.add('err');
      return;
    }
    var invalid = batch.records.filter(function (r) { return !r.valid; });
    var lines = ['已识别 ' + batch.records.length + ' 条记录（' +
      (batch.records.length - invalid.length) +
      ' 条通过校验）；点击「开始校样」逐条试排。'];
    invalid.forEach(function (rec) {
      lines.push('第 ' + rec.no + ' 条记录：' + rec.error);
    });
    el.batchHint.textContent = lines.join('\n');
    if (invalid.length) el.batchHint.classList.add('err');
  }

  function showBatchError(message) {
    el.batchResult.innerHTML = '';
    var div = document.createElement('div');
    div.className = 'batch-result-errs';
    div.textContent = message;
    el.batchResult.appendChild(div);
    el.batchResult.hidden = false;
  }

  // 点击「开始校样」：以当前尺寸与设置为每条通过校验的记录试排
  function runBatchProof() {
    var batch = window.LabelBatch.buildBatch(el.batchCsv.value);
    if (batch.errors.length) {
      showBatchError(batch.errors.join('\n'));
      invalidateBatchSheets('校样未通过（原因见上方），异款拼版已清空；修正后请重新点击「开始校样」。');
      return;
    }

    // 当前设置的阻塞性错误（链接/保护表/术语表/尺寸）未解决时不校样
    var c = collectInputs();
    if (c.qrError) {
      showBatchError('当前展品介绍链接有误，无法校样：\n' + c.qrError);
      invalidateBatchSheets('校样未通过（原因见上方），异款拼版已清空；修正后请重新点击「开始校样」。');
      return;
    }
    if (c.protect.error) {
      showBatchError('当前专名保护表有误，无法校样：\n' + c.protect.error);
      invalidateBatchSheets('校样未通过（原因见上方），异款拼版已清空；修正后请重新点击「开始校样」。');
      return;
    }
    var glossary = window.LabelTerms.parseGlossary(el.glossary.value);
    if (glossary.errors.length) {
      showBatchError('当前双语术语对照表有误，无法校样：\n' + glossary.errors.join('\n'));
      invalidateBatchSheets('校样未通过（原因见上方），异款拼版已清空；修正后请重新点击「开始校样」。');
      return;
    }
    if (!(c.input.widthMm >= 30 && c.input.widthMm <= 999 &&
          c.input.heightMm >= 20 && c.input.heightMm <= 999)) {
      showBatchError('当前标签尺寸无效（宽 30–999mm，高 20–999mm），无法校样。');
      invalidateBatchSheets('校样未通过（原因见上方），异款拼版已清空；修正后请重新点击「开始校样」。');
      return;
    }

    var paraAlignOn = el.paraAlign.checked;
    var rows = batch.records.map(function (rec) {
      if (!rec.valid) return { rec: rec, result: null, termFail: null, trial: null };
      var enTrim = rec.en.trim();
      // 仅替换三栏文案；尺寸、段落对齐、专名、二维码预留均沿用当前设置
      var trial = {
        title: rec.title,
        body: rec.zh,
        bodyEn: rec.en,
        widthMm: c.input.widthMm,
        heightMm: c.input.heightMm,
        titleTrim: rec.title.trim(),
        bodyTrim: rec.zh.trim(),
        enTrim: enTrim,
        dual: enTrim.length > 0,
        paired: enTrim.length > 0 && paraAlignOn,
        protectedWords: c.input.protectedWords,
        reserveBottomMm: c.input.reserveBottomMm
      };
      var result = computeLayout(trial);
      // 打印门禁：当前已录入术语且该记录为段落对齐双栏时，逐段核对术语次数
      var termFail = null;
      if (result.ok && glossary.entries.length && trial.paired) {
        var chk = window.LabelTerms.checkParagraphs(
          trial.bodyTrim, trial.enTrim, glossary.entries);
        if (chk.mismatches.length) {
          termFail = '术语核对未通过：' + chk.mismatches.length +
            ' 处术语次数不符（载入后可在「双语术语核对」区查看明细）';
        }
      }
      return { rec: rec, result: result, termFail: termFail, trial: trial };
    });

    renderBatchResult(c, glossary.entries.length, paraAlignOn, rows);
    // 异款批量拼版：通过记录按原顺序各自生成展签并拼入 A4 页，失败记录不进入拼版
    buildBatchImpose(c, rows);
  }

  // 校样结果：逐条列出可用字号或失败原因；通过记录提供「载入编辑」
  function renderBatchResult(c, termCount, paraAlignOn, rows) {
    el.batchResult.innerHTML = '';
    el.batchResult.hidden = false;

    var passCount = rows.filter(function (r) {
      return r.result && r.result.ok && !r.termFail;
    }).length;

    var head = document.createElement('div');
    head.className = 'batch-result-head';
    head.textContent = '校样依据（沿用当前设置，不改变当前成品）：尺寸 ' +
      c.input.widthMm + '×' + c.input.heightMm + 'mm' +
      ' · 段落对齐' + (paraAlignOn ? '开' : '关') +
      ' · 保护词 ' + (c.input.protectedWords ? c.input.protectedWords.length : 0) + ' 个' +
      (c.qr ? ' · 预留 ' + QR_BAND_MM + 'mm 二维码区' : ' · 无二维码') +
      (termCount ? ' · 术语 ' + termCount + ' 对' : '') +
      '。\n共 ' + rows.length + ' 条记录，' + passCount + ' 条通过校样' +
      (passCount
        ? '，已按原顺序拼入右侧「异款批量拼版预览」（失败记录不进入拼版）'
        : '；没有记录进入异款拼版') +
      '；修改尺寸或设置后请重新点击「开始校样」。';
    el.batchResult.appendChild(head);

    var table = document.createElement('table');
    table.className = 'batch-table';
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    ['记录', '标题', '校样结果', '操作'].forEach(function (txt) {
      var th = document.createElement('th');
      th.textContent = txt;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');

    rows.forEach(function (row) {
      var rec = row.rec;
      var tr = document.createElement('tr');
      var noTd = document.createElement('td');
      noTd.textContent = '第 ' + rec.no + ' 条';
      var titleTd = document.createElement('td');
      titleTd.textContent = briefTitle(rec.title);
      var resTd = document.createElement('td');
      var actTd = document.createElement('td');

      if (!rec.valid) {
        resTd.className = 'bad';
        resTd.textContent = '✗ ' + rec.error;
        actTd.textContent = '—';
      } else if (!row.result.ok) {
        resTd.className = 'bad';
        resTd.textContent = stockFailNote(row.result, !!c.qr);
        actTd.textContent = '—';
      } else if (row.termFail) {
        resTd.className = 'bad';
        resTd.textContent = '✗ ' + row.termFail;
        actTd.textContent = '—';
      } else {
        resTd.className = 'good';
        resTd.textContent = '✓ 可用 ' + row.result.bodyPx + 'px';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'batch-load';
        btn.textContent = '载入编辑';
        btn.addEventListener('click', function () { loadBatchRecord(rec); });
        actTd.appendChild(btn);
      }

      tr.appendChild(noTd);
      tr.appendChild(titleTd);
      tr.appendChild(resTd);
      tr.appendChild(actTd);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    el.batchResult.appendChild(table);

    if (passCount) {
      var tip = document.createElement('div');
      tip.className = 'batch-result-head';
      tip.textContent = '点击「载入编辑」才把该记录的标题、中文正文与英文译文回填到上方输入框' +
        '（同时清空修订稿），随后由原有预览与打印流程处理；未载入前当前成品不变。';
      el.batchResult.appendChild(tip);
    }
  }

  // 标题摘要：去换行并截断，便于在结果表中识别记录
  function briefTitle(title) {
    var t = String(title).replace(/\s+/g, ' ').trim();
    var cps = Array.from(t);
    if (!cps.length) return '（空）';
    return cps.length > 12 ? cps.slice(0, 12).join('') + '…' : t;
  }

  // 载入编辑：回填三栏并清空修订稿，随后由原有预览与打印流程处理
  function loadBatchRecord(rec) {
    el.title.value = rec.title.replace(/\r\n?|\n/g, ' '); // 标题输入框为单行
    el.body.value = rec.zh;
    el.bodyEn.value = rec.en;
    el.bodyRev.value = ''; // 清空修订稿：恢复原稿为成品
    updateRevCount(false);
    render();
  }

  // ---------- 馆藏号对账 ----------
  // 沿用「批量校样」的 CSV（表头须含 accession 列且各记录非空）与另行粘贴的
  // 馆藏登记清单（每行一项）核对；号码格式、区间展开与差异计算见 accession.js。
  // 对账只读：不改变校样结果、拼版与打印；CSV 或清单任一变化即清空旧结果。

  function regLineLabel(line) { return '第 ' + line + ' 行'; }
  function csvRecLabel(no) { return '第 ' + no + ' 条记录'; }

  function clearAccessionResult() {
    el.accResult.hidden = true;
    el.accResult.innerHTML = '';
  }

  // 清单输入提示：实时解析并校验格式与展开上限（不展开保存），并清空旧对账结果
  function updateAccessionHint() {
    clearAccessionResult();
    var raw = el.accRegistry.value;
    el.accHint.classList.remove('err');
    if (!String(raw).trim()) {
      el.accHint.textContent = '未粘贴登记清单';
      return;
    }
    var reg = window.LabelAccession.parseRegistry(raw);
    var side = window.LabelAccession.expandSide(reg.items, '登记清单', regLineLabel);
    if (side.errors.length) {
      el.accHint.textContent = '已识别 ' + reg.items.length + ' 项，但存在错误：\n' +
        side.errors.join('\n');
      el.accHint.classList.add('err');
      return;
    }
    el.accHint.textContent = '已识别 ' + reg.items.length + ' 项，展开共 ' +
      side.numbers.length + ' 个号码；点击「开始对账」与 CSV 的 accession 列核对。';
  }

  function showAccessionError(message) {
    el.accResult.innerHTML = '';
    var div = document.createElement('div');
    div.className = 'acc-result-errs';
    div.textContent = message;
    el.accResult.appendChild(div);
    el.accResult.hidden = false;
  }

  // 点击「开始对账」：核对 CSV 的 accession 列与馆藏登记清单（只读）
  function runAccessionReconcile() {
    // CSV 侧：沿用批量校样入口，须含 accession 列且各记录非空
    var batch = window.LabelBatch.buildBatch(el.batchCsv.value);
    if (batch.errors.length) {
      showAccessionError('批量校样 CSV 有误，无法对账：\n' + batch.errors.join('\n'));
      return;
    }
    var accCol = batch.colIndex ? batch.colIndex.accession : undefined;
    if (accCol === undefined) {
      showAccessionError('CSV 表头缺少 accession 列：请在批量校样 CSV 中增加 accession 列' +
        '（表头须含 title,zh,en,accession，顺序任意，可含其他额外列），各记录的馆藏号必填。');
      return;
    }
    var csvItems = [];
    var csvErrs = [];
    batch.records.forEach(function (rec) {
      if (rec.cells.length !== batch.colCount) {
        csvErrs.push('CSV 第 ' + rec.no + ' 条记录列数不符（本记录 ' + rec.cells.length +
          ' 列，表头 ' + batch.colCount + ' 列），无法定位 accession 列；请先修正该记录。');
        return;
      }
      var raw = String(rec.cells[accCol] == null ? '' : rec.cells[accCol]).trim();
      if (!raw) {
        csvErrs.push('CSV 第 ' + rec.no + ' 条记录的 accession 为空：对账要求各记录馆藏号必填。');
        return;
      }
      csvItems.push({ text: raw, line: rec.no });
    });
    if (csvErrs.length) {
      showAccessionError(csvErrs.join('\n'));
      return;
    }
    var csvSide = window.LabelAccession.expandSide(csvItems, 'CSV', csvRecLabel);
    if (csvSide.errors.length) {
      showAccessionError(csvSide.errors.join('\n'));
      return;
    }

    // 登记清单侧：每行一项，空行忽略
    var reg = window.LabelAccession.parseRegistry(el.accRegistry.value);
    if (!reg.items.length) {
      showAccessionError('请在上方粘贴馆藏登记清单（每行一项：号码或同前缀区间，空行忽略）。');
      return;
    }
    var regSide = window.LabelAccession.expandSide(reg.items, '登记清单', regLineLabel);
    if (regSide.errors.length) {
      showAccessionError(regSide.errors.join('\n'));
      return;
    }

    renderAccessionResult(
      window.LabelAccession.reconcile(csvSide.numbers, regSide.numbers));
  }

  // 差异小节表格：号码列等宽显示，表格过高时内部滚动
  function appendAccTable(title, headers, rows) {
    if (!rows.length) return;
    var sub = document.createElement('div');
    sub.className = 'acc-sub';
    sub.textContent = title + '（' + rows.length + ' 个号码）';
    el.accResult.appendChild(sub);
    var wrap = document.createElement('div');
    wrap.className = 'acc-table-wrap';
    var table = document.createElement('table');
    table.className = 'acc-table';
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    headers.forEach(function (txt) {
      var th = document.createElement('th');
      th.textContent = txt;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    rows.forEach(function (cells) {
      var tr = document.createElement('tr');
      cells.forEach(function (txt, idx) {
        var td = document.createElement('td');
        td.textContent = txt;
        if (idx === 0) td.className = 'acc-no';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    el.accResult.appendChild(wrap);
  }

  function joinRecNos(lines) {
    return lines.map(function (no) { return '第 ' + no + ' 条'; }).join('、');
  }

  function joinLineNos(lines) {
    return lines.map(function (no) { return '第 ' + no + ' 行'; }).join('、');
  }

  // 对账结果：摘要 + 各差异小节；全部一致时给出绿色结论
  function renderAccessionResult(res) {
    el.accResult.innerHTML = '';
    el.accResult.hidden = false;

    var head = document.createElement('div');
    head.className = 'acc-result-head';
    head.textContent = '对账依据（只读，不改变校样、拼版与打印）：CSV 侧展开 ' +
      res.csvTotal + ' 个号码（去重 ' + res.csvUnique + ' 个），登记清单侧展开 ' +
      res.regTotal + ' 个（去重 ' + res.regUnique + ' 个），两侧共有 ' + res.common +
      ' 个；顺序不同不算差异。修改 CSV 或清单后本结果自动清空，需重新对账。';
    el.accResult.appendChild(head);

    var diffCount = res.csvDupes.length + res.regDupes.length +
      res.onlyCsv.length + res.onlyReg.length;
    if (!diffCount) {
      var ok = document.createElement('div');
      ok.className = 'acc-result-ok';
      ok.textContent = '✓ 对账一致：两侧号码集合完全相同，且各自内部无重号。';
      el.accResult.appendChild(ok);
      return;
    }

    appendAccTable('CSV 内重号（含号段交叠）',
      ['号码', '次数', '来源（CSV 记录）'],
      res.csvDupes.map(function (d) {
        return [d.no, d.count + ' 次', joinRecNos(d.lines)];
      }));
    appendAccTable('登记清单内重号（含号段交叠）',
      ['号码', '次数', '来源（清单行）'],
      res.regDupes.map(function (d) {
        return [d.no, d.count + ' 次', joinLineNos(d.lines)];
      }));
    appendAccTable('仅在 CSV 中的号码（登记清单缺失）',
      ['号码', '来源（CSV 记录）'],
      res.onlyCsv.map(function (d) {
        return [d.no, joinRecNos(d.lines)];
      }));
    appendAccTable('仅在登记清单中的号码（CSV 缺失）',
      ['号码', '来源（清单行）'],
      res.onlyReg.map(function (d) {
        return [d.no, joinLineNos(d.lines)];
      }));
  }

  // 排版失败：清空成品内容并显示错误占位（占位元素常驻，打印样式保证其不输出）
  function showError(message) {
    el.label.innerHTML = '';
    el.label.appendChild(el.labelError);
    el.labelError.textContent = message;
    el.labelError.hidden = false;
  }

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  // ---------- 屏幕预览缩放（仅显示用，不影响打印的毫米尺寸） ----------
  function fitScale() {
    var wMm = parseFloat(el.widthMm.value) || 120;
    var hMm = parseFloat(el.heightMm.value) || 80;
    var availW = el.stage.clientWidth - 24;
    var availH = el.stage.clientHeight - 24;
    var labelW = wMm * PX_PER_MM;
    var labelH = hMm * PX_PER_MM;
    var scale = Math.min(1, availW / labelW, availH / labelH);
    if (!(scale > 0) || !isFinite(scale)) scale = 1;
    el.label.style.transform = 'scale(' + scale + ')';
  }

  // ---------- 同款拼版：A4 纸内按原尺寸逐份生成同一成品 ----------
  function fmtMm(n) {
    return (Math.round(n * 10) / 10) + 'mm';
  }

  // 份数校验：1～100 的整数；非法返回 null
  function parseCopies() {
    var raw = String(el.copies.value).trim();
    if (!/^\d+$/.test(raw)) return null;
    var n = parseInt(raw, 10);
    return (n >= COPIES_MIN && n <= COPIES_MAX) ? n : null;
  }

  // 行列容量：纸内可用 = 纸张 − 每边 10mm 留白；n 张需 n×签 + (n−1)×间隔 ≤ 可用边长
  function planSheetCapacity(labelW, labelH, landscape) {
    var pageW = landscape ? A4_H_MM : A4_W_MM;
    var pageH = landscape ? A4_W_MM : A4_H_MM;
    var usableW = pageW - SHEET_MARGIN_MM * 2;
    var usableH = pageH - SHEET_MARGIN_MM * 2;
    var cols = Math.floor((usableW + SHEET_GAP_MM + 1e-6) / (labelW + SHEET_GAP_MM));
    var rows = Math.floor((usableH + SHEET_GAP_MM + 1e-6) / (labelH + SHEET_GAP_MM));
    return {
      pageW: pageW, pageH: pageH, usableW: usableW, usableH: usableH,
      cols: cols, rows: rows
    };
  }

  // 逐页填充：每页 cols×rows 张，从左到右、从上到下；最后一页可能不满
  function buildSheets(plan, labelW, labelH, copies) {
    el.sheets.innerHTML = '';
    var perPage = plan.cols * plan.rows;
    var pages = Math.ceil(copies / perPage);
    for (var p = 0; p < pages; p++) {
      var block = document.createElement('div');
      block.className = 'sheet-block';
      var wrap = document.createElement('div');
      wrap.className = 'sheet-wrap';
      var sheet = document.createElement('div');
      sheet.className = 'sheet';
      sheet.style.width = plan.pageW + 'mm';
      sheet.style.height = plan.pageH + 'mm';
      var count = Math.min(perPage, copies - p * perPage);
      for (var i = 0; i < count; i++) {
        var col = i % plan.cols;
        var row = Math.floor(i / plan.cols);
        var cell = buildLabelElement(lastGood.input, lastGood.result, currentQr);
        cell.style.left = (SHEET_MARGIN_MM + col * (labelW + SHEET_GAP_MM)) + 'mm';
        cell.style.top = (SHEET_MARGIN_MM + row * (labelH + SHEET_GAP_MM)) + 'mm';
        sheet.appendChild(cell);
      }
      wrap.appendChild(sheet);
      block.appendChild(wrap);
      var cap = document.createElement('div');
      cap.className = 'sheet-caption';
      cap.textContent = '第 ' + (p + 1) + ' / ' + pages + ' 页 · 本页 ' + count + ' 张';
      block.appendChild(cap);
      el.sheets.appendChild(block);
    }
    return pages;
  }

  function setSheetHint(text, kind) {
    el.sheetHint.textContent = text;
    el.sheetHint.className = 'sheet-hint' + (kind ? ' ' + kind : '');
  }

  function showSheetEmpty(msg) {
    el.sheetEmpty.textContent = msg;
    el.sheetEmpty.className = 'sheet-empty err';
    el.sheetEmpty.hidden = false;
  }

  // 拼版区刷新：仅当所选成品（原稿或修订稿）通过现有排版校验时才生成拼版；
  // block 为 { hint, sub } 时用于排版以外的原因（如术语核对未通过）禁用拼版并说明
  function updateSheets(layoutOk, block) {
    lastSheets = null;
    el.sheetPrintBtn.disabled = true;
    el.sheets.innerHTML = '';
    el.sheetEmpty.hidden = true;

    var landscape = el.orientLandscape.checked;
    var orientName = landscape ? '横向' : '纵向';

    if (!layoutOk) {
      var hint = block && block.hint
        ? block.hint
        : '当前成品未通过排版校验，拼版打印不可用。';
      setSheetHint(hint, 'err');
      el.sheetAreaSub.textContent = block && block.sub
        ? block.sub
        : '拼版不可用：请先解决上方的排版错误';
      showSheetEmpty(hint);
      return;
    }

    var copies = parseCopies();
    if (copies == null) {
      setSheetHint('份数需为 ' + COPIES_MIN + '～' + COPIES_MAX + ' 的整数。', 'err');
      el.sheetAreaSub.textContent = '拼版不可用：份数需为 1～100 的整数';
      showSheetEmpty('份数需为 ' + COPIES_MIN + '～' + COPIES_MAX + ' 的整数。');
      return;
    }

    var labelW = parseFloat(el.widthMm.value);
    var labelH = parseFloat(el.heightMm.value);
    var plan = planSheetCapacity(labelW, labelH, landscape);

    // 任一方向连一张都放不下：提示展签尺寸与纸内可用尺寸并禁用拼版打印
    if (plan.cols < 1 || plan.rows < 1) {
      var msg = 'A4 ' + orientName + '纸内连一张展签都放不下：展签 ' +
        fmtMm(labelW) + ' × ' + fmtMm(labelH) +
        '，纸内可用 ' + fmtMm(plan.usableW) + ' × ' + fmtMm(plan.usableH) +
        '（A4 ' + orientName + ' ' + plan.pageW + '×' + plan.pageH + 'mm，' +
        '每边留白 ' + SHEET_MARGIN_MM + 'mm）。';
      setSheetHint(msg + '\n可切换纸张方向或缩小展签尺寸；拼版打印已禁用。', 'err');
      el.sheetAreaSub.textContent = '拼版不可用：展签超出纸内可用尺寸';
      showSheetEmpty(msg + '\n可切换纸张方向或缩小展签尺寸。');
      return;
    }

    var perPage = plan.cols * plan.rows;
    var pages = buildSheets(plan, labelW, labelH, copies);
    lastSheets = {
      pageW: plan.pageW, pageH: plan.pageH,
      cols: plan.cols, rows: plan.rows, pages: pages
    };
    el.sheetPrintBtn.disabled = false;
    setSheetHint('A4 ' + orientName + '：每页 ' + plan.cols + ' 列 × ' + plan.rows +
      ' 行 = ' + perPage + ' 张，' + copies + ' 份共 ' + pages + ' 页；每边留白 ' +
      SHEET_MARGIN_MM + 'mm、展签间隔 ' + SHEET_GAP_MM + 'mm，按原毫米尺寸拼版，不缩放。', 'ok');
    el.sheetAreaSub.textContent = 'A4 ' + orientName + ' · 每页 ' + plan.cols +
      ' × ' + plan.rows + ' = ' + perPage + ' 张 · ' + copies + ' 份共 ' + pages + ' 页';
    fitSheets();
  }

  // 屏幕上的纸张整体缩放（仅显示用；打印时 transform 被打印样式清除，纸张 1:1）
  function fitSheets() {
    if (!lastSheets) return;
    var availW = el.sheetArea.clientWidth - 48;
    var wPx = lastSheets.pageW * PX_PER_MM;
    var hPx = lastSheets.pageH * PX_PER_MM;
    var scale = availW > 0 ? Math.min(1, availW / wPx) : 1;
    if (!(scale > 0) || !isFinite(scale)) scale = 1;
    var wraps = el.sheets.querySelectorAll('.sheet-wrap');
    for (var i = 0; i < wraps.length; i++) {
      wraps[i].style.width = Math.round(wPx * scale) + 'px';
      wraps[i].style.height = Math.round(hPx * scale) + 'px';
      var sheet = wraps[i].querySelector('.sheet');
      if (sheet) sheet.style.transform = 'scale(' + scale + ')';
    }
  }

  // ---------- 异款批量拼版：校样通过的不同记录按原顺序拼入 A4 页 ----------
  // 每条通过记录用自己的排版结果独立生成展签 DOM（预断行、段落对齐 grid 与
  // 二维码码图各自保留），再按当前展签毫米尺寸、纸张方向、每边 10mm 留白与
  // 4mm 间隔逐页排入 A4；失败记录只在校样结果中列出原因，不进入拼版。

  // 校样完成后生成拼版素材：通过记录按 CSV 原顺序各自生成展签，失败记录不进入拼版
  // （buildLabelElement 为上方单张预览同款的共用构建流程，每张持有独立二维码 canvas，
  // 分页时仅移动节点、不重绘，码图保持不变）
  function buildBatchImpose(c, rows) {
    var labels = [];
    var failed = 0;
    rows.forEach(function (row) {
      if (row.result && row.result.ok && !row.termFail) {
        labels.push(buildLabelElement(row.trial, row.result, c.qr));
      } else {
        failed++;
      }
    });
    batchImpose = {
      labels: labels,
      labelW: c.input.widthMm,
      labelH: c.input.heightMm,
      failed: failed
    };
    paginateBatchSheets();
  }

  function setBatchSheetHint(text, kind) {
    el.batchSheetHint.textContent = text;
    el.batchSheetHint.className = 'sheet-hint' + (kind ? ' ' + kind : '');
  }

  function showBatchSheetEmpty(msg, isErr) {
    el.batchSheetEmpty.textContent = msg;
    el.batchSheetEmpty.className = 'sheet-empty' + (isErr ? ' err' : '');
    el.batchSheetEmpty.hidden = false;
  }

  // 按当前纸张方向把拼版素材逐页排入 A4：每页 cols×rows 张，
  // 从左到右、从上到下，展签顺序即 CSV 原顺序；最后一页可能不满
  function paginateBatchSheets() {
    lastBatchSheets = null;
    el.batchSheetPrintBtn.disabled = true;
    el.batchSheets.innerHTML = '';
    el.batchSheetEmpty.hidden = true;

    if (!batchImpose) {
      setBatchSheetHint('尚未生成异款拼版：在「批量校样」区粘贴 CSV 并点击「开始校样」，' +
        '通过校验的记录将按原顺序拼入 A4 页。');
      el.batchSheetAreaSub.textContent = '校样通过的不同记录按原顺序拼入 A4 页';
      showBatchSheetEmpty('尚未生成异款拼版：请先在「批量校样」区粘贴 CSV 并点击「开始校样」，' +
        '通过校验的不同记录会按原顺序排入这里的 A4 印刷页。');
      return;
    }
    if (!batchImpose.labels.length) {
      setBatchSheetHint('没有通过校样的记录，异款拼版不可用；失败原因见上方校样结果。', 'err');
      el.batchSheetAreaSub.textContent = '异款拼版不可用：没有通过校样的记录';
      showBatchSheetEmpty('没有通过校样的记录：各记录的失败原因见上方校样结果，' +
        '修正 CSV 或当前设置后请重新点击「开始校样」。', true);
      return;
    }

    var landscape = el.orientLandscape.checked;
    var orientName = landscape ? '横向' : '纵向';
    var labelW = batchImpose.labelW;
    var labelH = batchImpose.labelH;
    var plan = planSheetCapacity(labelW, labelH, landscape);

    // 单页连一张都放不下：说明展签尺寸与纸内可用尺寸并禁用异款拼版打印
    if (plan.cols < 1 || plan.rows < 1) {
      var msg = 'A4 ' + orientName + '纸内连一张展签都放不下：展签 ' +
        fmtMm(labelW) + ' × ' + fmtMm(labelH) +
        '，纸内可用 ' + fmtMm(plan.usableW) + ' × ' + fmtMm(plan.usableH) +
        '（A4 ' + orientName + ' ' + plan.pageW + '×' + plan.pageH + 'mm，' +
        '每边留白 ' + SHEET_MARGIN_MM + 'mm）。';
      setBatchSheetHint(msg + '\n可切换纸张方向，或缩小展签尺寸后重新校样；异款拼版打印已禁用。', 'err');
      el.batchSheetAreaSub.textContent = '异款拼版不可用：展签超出纸内可用尺寸';
      showBatchSheetEmpty(msg + '\n可切换纸张方向，或缩小展签尺寸后重新点击「开始校样」。', true);
      return;
    }

    var perPage = plan.cols * plan.rows;
    var total = batchImpose.labels.length;
    var pages = Math.ceil(total / perPage);
    for (var p = 0; p < pages; p++) {
      var block = document.createElement('div');
      block.className = 'sheet-block';
      var wrap = document.createElement('div');
      wrap.className = 'sheet-wrap';
      var sheet = document.createElement('div');
      sheet.className = 'sheet';
      sheet.style.width = plan.pageW + 'mm';
      sheet.style.height = plan.pageH + 'mm';
      var count = Math.min(perPage, total - p * perPage);
      for (var i = 0; i < count; i++) {
        var col = i % plan.cols;
        var row = Math.floor(i / plan.cols);
        var cell = batchImpose.labels[p * perPage + i];
        cell.style.left = (SHEET_MARGIN_MM + col * (labelW + SHEET_GAP_MM)) + 'mm';
        cell.style.top = (SHEET_MARGIN_MM + row * (labelH + SHEET_GAP_MM)) + 'mm';
        sheet.appendChild(cell);
      }
      wrap.appendChild(sheet);
      block.appendChild(wrap);
      var cap = document.createElement('div');
      cap.className = 'sheet-caption';
      cap.textContent = '第 ' + (p + 1) + ' / ' + pages + ' 页 · 本页 ' + count + ' 张';
      block.appendChild(cap);
      el.batchSheets.appendChild(block);
    }

    lastBatchSheets = {
      pageW: plan.pageW, pageH: plan.pageH,
      cols: plan.cols, rows: plan.rows, pages: pages
    };
    el.batchSheetPrintBtn.disabled = false;
    setBatchSheetHint('A4 ' + orientName + '：每页 ' + plan.cols + ' 列 × ' + plan.rows +
      ' 行 = ' + perPage + ' 张，' + total + ' 张不同展签共 ' + pages + ' 页；每边留白 ' +
      SHEET_MARGIN_MM + 'mm、展签间隔 ' + SHEET_GAP_MM + 'mm，按原毫米尺寸拼版，不缩放。' +
      (batchImpose.failed
        ? '\n另有 ' + batchImpose.failed + ' 条记录未通过校样，未进入拼版（原因见上方校样结果）。'
        : ''), 'ok');
    el.batchSheetAreaSub.textContent = 'A4 ' + orientName + ' · 每页 ' + plan.cols +
      ' × ' + plan.rows + ' = ' + perPage + ' 张 · ' + total + ' 张不同展签共 ' + pages + ' 页';
    fitBatchSheets();
  }

  // 屏幕上的纸张整体缩放（仅显示用；打印时 transform 被打印样式清除，纸张 1:1）
  function fitBatchSheets() {
    if (!lastBatchSheets) return;
    var availW = el.batchSheetArea.clientWidth - 48;
    var wPx = lastBatchSheets.pageW * PX_PER_MM;
    var hPx = lastBatchSheets.pageH * PX_PER_MM;
    var scale = availW > 0 ? Math.min(1, availW / wPx) : 1;
    if (!(scale > 0) || !isFinite(scale)) scale = 1;
    var wraps = el.batchSheets.querySelectorAll('.sheet-wrap');
    for (var i = 0; i < wraps.length; i++) {
      wraps[i].style.width = Math.round(wPx * scale) + 'px';
      wraps[i].style.height = Math.round(hPx * scale) + 'px';
      var sheet = wraps[i].querySelector('.sheet');
      if (sheet) sheet.style.transform = 'scale(' + scale + ')';
    }
  }

  // 尺寸、段落对齐、专名、术语、二维码或 CSV 变化后，已生成的异款拼版失效：
  // 清空预览并禁用打印，重新点击「开始校样」后按新设置重新生成
  function invalidateBatchSheets(reason) {
    if (!batchImpose) return;
    batchImpose = null;
    lastBatchSheets = null;
    el.batchSheetPrintBtn.disabled = true;
    el.batchSheets.innerHTML = '';
    setBatchSheetHint(reason, 'err');
    el.batchSheetAreaSub.textContent = '异款拼版不可用：设置已修改，请重新校样';
    showBatchSheetEmpty(reason, true);
  }

  // ---------- 打印门禁 ----------
  var pageStyle = null;
  // 打印前必须依据「当前输入」重新判定可打印成品，而不能沿用防抖窗口前的
  // lastGood 与按钮状态：flushRender() 先同步结算待处理渲染，再读取本次
  // 渲染刷新后的门禁。无效时返回非空原因，打印样式不输出单张或任何拼版内容。
  function resolvePrintMode() {
    if (printMode === 'sheet') {
      if (!el.sheetPrintBtn.disabled && lastSheets) return 'sheet';
      return null;
    }
    if (printMode === 'batch') {
      if (!el.batchSheetPrintBtn.disabled && lastBatchSheets) return 'batch';
      return null;
    }
    // Ctrl+P 默认单张；单张以刚渲染出的 lastGood 与单张按钮门禁为准
    if (!el.printBtn.disabled && lastGood) return 'single';
    return null;
  }

  // 各打印方式被拦截时的说明（单张取当前状态行，即本次渲染给出的失败原因）
  function blockedReason(mode) {
    if (mode === 'sheet') {
      return el.sheetHint.textContent.trim() ||
        '当前成品未通过校验，拼版打印不可用。';
    }
    if (mode === 'batch') {
      return el.batchSheetHint.textContent.trim() ||
        '异款拼版未生成或已失效，请重新点击「开始校样」后再打印。';
    }
    return el.status.textContent.trim() ||
      '当前内容未通过排版、二维码或术语校验，不能打印；请先修正输入。';
  }

  function beforePrint() {
    flushRender(); // 结算 120ms 防抖窗口内尚未应用的修改
    var mode = resolvePrintMode();
    document.body.classList.toggle('print-sheet', mode === 'sheet');
    document.body.classList.toggle('print-batch', mode === 'batch');
    document.body.classList.toggle('print-none', !mode);
    if (!pageStyle) {
      pageStyle = document.createElement('style');
      document.head.appendChild(pageStyle);
    }
    if (mode === 'batch') {
      pageStyle.textContent = '@page { size: ' + lastBatchSheets.pageW + 'mm ' +
        lastBatchSheets.pageH + 'mm; margin: 0; }';
    } else if (mode === 'sheet') {
      pageStyle.textContent = '@page { size: ' + lastSheets.pageW + 'mm ' +
        lastSheets.pageH + 'mm; margin: 0; }';
    } else if (mode === 'single') {
      pageStyle.textContent = '@page { size: ' +
        lastGood.input.widthMm + 'mm ' + lastGood.input.heightMm + 'mm; margin: 0; }';
    } else {
      // 无效：不设置任何标签/拼版页尺寸，配合 body.print-none 不输出任何成品
      pageStyle.textContent = '';
    }
  }

  // ---------- 初始化 ----------
  el.body.value =
    '新石器时代·仰韶文化，约公元前 5000–前 3000 年。\n' +
    '泥质红陶，器表刻划有几何纹（geometric patterns），是研究黄河中游早期制陶工艺（pottery craftsmanship）的重要实物。出土于河南省渑池县仰韶村，1951 年入藏。';
  // 英文译文默认留空：页面初次打开保持原有单栏呈现。
  // 修订稿默认留空：不进入对照模式。

  var selectedVersion = 'orig'; // 成品版本：'orig' 原稿 / 'rev' 修订稿
  var revWasActive = false;     // 上一轮渲染时修订稿是否非空（用于新填写时默认选中修订稿）

  // 输入变化后 120ms 防抖重排。打印前必须先调用 flushRender() 立即结算待处理
  // 渲染：否则在防抖窗口内按 Ctrl+P / 点打印，会按旧的 lastGood 与按钮状态
  // 输出修改前的成品。
  var schedule = (function () {
    var timer = null;
    function fn() { clearTimeout(timer); timer = setTimeout(render, 120); }
    fn.flush = function () {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
        render(); // 同步结算：依据当前输入重排并刷新 lastGood 与各打印门禁
      }
    };
    return fn;
  })();
  function flushRender() { schedule.flush(); }

  ['input', 'change'].forEach(function (evt) {
    el.title.addEventListener(evt, schedule);
    el.body.addEventListener(evt, schedule);
    el.bodyEn.addEventListener(evt, schedule);
    el.paraAlign.addEventListener(evt, schedule);
    el.glossary.addEventListener(evt, schedule);
    el.qrLink.addEventListener(evt, schedule);
    el.protect.addEventListener(evt, schedule);
    el.widthMm.addEventListener(evt, schedule);
    el.heightMm.addEventListener(evt, schedule);
    el.copies.addEventListener(evt, schedule);
  });

  // A4 纸张方向切换：实时重算同款拼版；异款拼版沿用同一方向选择，按新方向重新分页
  [el.orientPortrait, el.orientLandscape].forEach(function (radio) {
    radio.addEventListener('change', schedule);
    radio.addEventListener('change', function () {
      if (batchImpose) paginateBatchSheets();
    });
  });

  // 影响异款批量拼版的设置（尺寸、段落对齐、专名、术语、二维码）变化后拼版失效，
  // 需重新点击「开始校样」按新设置生成（CSV 修改的失效处理见 updateBatchHint）
  [el.widthMm, el.heightMm, el.paraAlign, el.protect, el.glossary, el.qrLink]
    .forEach(function (input) {
      ['input', 'change'].forEach(function (evt) {
        input.addEventListener(evt, function () {
          invalidateBatchSheets('排版设置已修改：异款拼版已失效，请重新点击「开始校样」按新设置生成。');
        });
      });
    });

  // 修订稿：按 Unicode 字符计 300 字上限，超出部分截断
  function updateRevCount(truncated) {
    var n = Array.from(el.bodyRev.value).length;
    el.revCount.textContent = n + ' / ' + REV_LIMIT + (truncated ? '（已按上限截断）' : '');
    el.revCount.classList.toggle('over', n >= REV_LIMIT);
  }

  el.bodyRev.addEventListener('input', function () {
    var cps = Array.from(el.bodyRev.value);
    var truncated = cps.length > REV_LIMIT;
    if (truncated) {
      el.bodyRev.value = cps.slice(0, REV_LIMIT).join('');
    }
    updateRevCount(truncated);
    schedule();
  });
  el.bodyRev.addEventListener('change', schedule);

  // 成品版本选择：预览与打印随之切换
  [el.finalOrig, el.finalRev].forEach(function (radio) {
    radio.addEventListener('change', function () {
      selectedVersion = el.finalRev.checked ? 'rev' : 'orig';
      render();
    });
  });

  // 库存规格表：输入时仅更新提示并清空上次选型结果，不参与排版
  el.stockSizes.addEventListener('input', function () {
    el.stockResult.hidden = true;
    updateStockHint();
  });
  el.stockSizes.addEventListener('change', updateStockHint);
  // 选型：以当前成品版本与设置，对各库存规格求最大可用字号并给出推荐
  el.stockPickBtn.addEventListener('click', runStockPick);

  // 批量校样：输入 CSV 仅更新提示并清空上次校样结果，不参与排版、不改变成品；
  // 点击「开始校样」才以当前尺寸与设置逐条试排
  el.batchCsv.addEventListener('input', updateBatchHint);
  el.batchCsv.addEventListener('change', updateBatchHint);
  el.batchRunBtn.addEventListener('click', runBatchProof);

  // 馆藏号对账：清单输入仅更新提示并清空旧对账结果（CSV 变化的清空见 updateBatchHint）；
  // 点击「开始对账」才核对，对账只读、不参与排版与打印
  el.accRegistry.addEventListener('input', updateAccessionHint);
  el.accRegistry.addEventListener('change', updateAccessionHint);
  el.accRunBtn.addEventListener('click', runAccessionReconcile);

  updateRevCount(false);
  updateStockHint();
  updateBatchHint();
  updateAccessionHint();
  paginateBatchSheets(); // 初始空态：提示先粘贴 CSV 校样

  // 统一打印入口：先结算待处理渲染，再依据当前输入判定本次模式是否可打印。
  // 无效时不打开打印对话框，并在面板给出本次拦截原因；修正输入后直接打印即恢复。
  function requestPrint(mode) {
    printMode = mode;
    flushRender();
    var resolved = resolvePrintMode();
    if (!resolved) {
      var reason = blockedReason(mode);
      setStatus('已阻止打印：' + reason, 'err');
      return;
    }
    window.print();
  }

  el.printBtn.addEventListener('click', function () {
    requestPrint('single');
  });
  el.sheetPrintBtn.addEventListener('click', function () {
    requestPrint('sheet');
  });
  el.batchSheetPrintBtn.addEventListener('click', function () {
    requestPrint('batch');
  });

  // Ctrl/Cmd+P：浏览器快捷键不会经过按钮，故在捕获阶段拦截——先结算防抖
  // 渲染并按单张门禁重新判定；当前输入无效（排不下、二维码或术语校验失败等）
  // 时阻止打印，避免把修改前成品或错误占位展签送入打印机。
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey &&
        (e.key === 'p' || e.key === 'P' || e.keyCode === 80)) {
      e.preventDefault();
      e.stopPropagation();
      requestPrint('single');
    }
  }, true);

  window.addEventListener('beforeprint', beforePrint);
  window.addEventListener('afterprint', function () {
    // 打印结束后恢复默认单张模式，避免下次 Ctrl+P 误用拼版
    printMode = 'single';
    document.body.classList.remove('print-sheet');
    document.body.classList.remove('print-batch');
    document.body.classList.remove('print-none');
  });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      fitScale();
      fitSheets();
      fitBatchSheets();
    }, 80);
  });

  // 字体加载完成后重排，确保测量字宽与渲染一致
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(render);
  }
  render();
})();
