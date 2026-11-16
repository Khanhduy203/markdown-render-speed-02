// parse.js — dependency-free CommonMark 0.31.2 + GFM renderer whose parse(markdown)
// returns exactly the HTML marked 18.1.3 renders with default options (gfm on).
// Written from the CommonMark/GFM specs and black-box probing of marked's output.
// MIT License.

// ---------------- character helpers ----------------

// CommonMark punctuation: Unicode general categories P and S.
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunct(ch) { return ch !== undefined && ch !== '' && PUNCT_RE.test(ch); }
function isSpace(ch) { return ch === undefined || ch === '' || /\s/.test(ch); }

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

// ---------------- escaping ----------------

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Plain escape of all five characters (code spans/blocks, alt text after plain-text extraction).
function esc(s) { return s.replace(/[&<>"']/g, (c) => ESC_MAP[c]); }

// A valid character reference as marked recognizes it: numeric (<=7 decimal / <=6 hex
// digits) or named (&word; — any word, marked does not validate the name).
const REF_RE = /&(?:#\d{1,7};|#[xX][0-9a-fA-F]{1,6};|\w+;)|[&<>"']/g;

function decodeNumeric(m) {
  const body = m.slice(2, -1);
  let cp;
  if (body[0] === 'x' || body[0] === 'X') cp = parseInt(body.slice(1), 16);
  else cp = parseInt(body, 10);
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
  if (cp === 34) return '&quot;';
  if (cp === 38) return '&amp;';
  if (cp === 39) return '&#39;';
  if (cp === 60) return '&lt;';
  if (cp === 62) return '&gt;';
  return String.fromCodePoint(cp);
}

// Escape inline text: numeric references are decoded (marked quirk: 34/38/39/60/62 map
// to their entity spellings), named references pass through verbatim, other & < > " ' escape.
function escText(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  REF_RE.lastIndex = 0;
  return s.replace(REF_RE, (m) => {
    if (m.length > 1 && m[0] === '&') {
      if (m[1] === '#') return decodeNumeric(m);
      return m;
    }
    return ESC_MAP[m];
  });
}

// Escape for attribute-ish contexts (titles, alt): references pass through verbatim,
// numeric ones NOT decoded.
function escAttr(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  REF_RE.lastIndex = 0;
  return s.replace(REF_RE, (m) => (m.length > 1 && m[0] === '&' ? m : ESC_MAP[m]));
}

// URL for href/src: marked does no scheme sanitizing; it percent-encodes via encodeURI
// and escapes bare & (references pass through). Valid %XX sequences are kept.
function cleanUrl(href) {
  let out;
  try {
    out = href.split(/(%[0-9a-fA-F]{2}|%)/g).map((part, k) => (k % 2 === 1 ? part : encodeURI(part))).join('');
  } catch (e) { out = href; }
  if (out.indexOf('&') < 0) return out;
  REF_RE.lastIndex = 0;
  return out.replace(/&(?:#\d{1,7};|#[xX][0-9a-fA-F]{1,6};|\w+;)|&/g, (m) => (m.length > 1 ? m : '&amp;'));
}

// Resolve backslash escapes in a link destination/title: \ + ASCII punctuation -> the char.
function unescape(s) {
  if (s.indexOf('\\') < 0) return s;
  return s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
}

// Unicode case folding for label matching: JS toLowerCase misses the full
// foldings (ẞ/ß -> ss, ligatures). Backslashes are NOT resolved (cm-545).
const FOLD_MAP = { 'ß': 'ss', 'ẞ': 'ss', 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st', 'ǅ': 'ǆ', 'Ǆ': 'ǆ', 'ǈ': 'ǉ', 'Ǉ': 'ǉ', 'ǋ': 'ǌ', 'Ǌ': 'ǌ', 'Ǳ': 'ǳ', 'ﬀ': 'ff' };
function caseFold(s) {
  let out = '';
  for (const ch of s) out += FOLD_MAP[ch] || ch.toLowerCase();
  return out;
}

// Normalize a link reference label: collapse whitespace runs to one space, trim, case-fold.
function normLabel(s) {
  return caseFold(s.replace(/\s+/g, ' ').trim());
}

// ---------------- inline parsing ----------------
// Node list: [0, html] text/already-rendered, [1, ch, len, canOpen, canClose] delimiter,
// [2, kind, children] em(1)/strong(2) wrapper (children rendered at the end).

// ---------------- marked-compatible emphasis / strikethrough ----------------
// Marked's emStrong/del are regex-driven: at an opener, scan forward for a
// closer over a MASKED source (links, code spans, HTML and escapes replaced
// by same-length filler so their delimiters are invisible), applying the
// CommonMark rule-of-3 for emphasis and exact-length matching for del. The
// content is then parsed recursively. This replaces a delimiter stack, which
// disagrees with marked on partial-length matches (e.g. **a*b** stays strong).

const _P = '[\\p{P}\\p{S}]';
const _PS = '[\\s\\p{P}\\p{S}]';
const _NP = '[^\\s\\p{P}\\p{S}]';
// GFM variants: ~ is not punctuation for strong/em purposes.
const _PG = '(?!~)[\\p{P}\\p{S}]';
const _PSG = '(?!~)[\\s\\p{P}\\p{S}]';
const _NPG = '(?:[^\\s\\p{P}\\p{S}]|~)';

function buildDelimRe(core, flags, np, ps, p) {
  const s = core.split('notPunctSpace').join(np).split('punctSpace').join(ps).split('punct').join(p);
  return new RegExp(s, flags);
}

const EM_STRONG_L = buildDelimRe('^(?:\\*+(?:((?!\\*)punct)|([^\\s*]))?)|^_+(?:((?!_)punct)|([^\\s_]))?', 'u', _NPG, _PSG, _PG);
const EM_STRONG_R_AST = buildDelimRe(
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)'
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)'
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)'
  + '|[\\s](\\*+)(?!\\*)(?=punct)'
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)'
  + '|notPunctSpace(\\*+)(?=notPunctSpace)', 'gu', _NPG, _PSG, _PG);
const EM_STRONG_R_UND = buildDelimRe(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu', _NP, _PS, _P);
const DEL_L = buildDelimRe('^~~?(?:((?!~)punct)|[^\\s~])', 'u', _NP, _PS, _P);
const DEL_R = buildDelimRe(
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)', 'gu', _NP, _PS, _P);

const PUNCT_TEST = /^((?![*_])[\s\p{P}\p{S}])/u;
const ALNUM_TEST = /[\p{L}\p{N}]/u;

// Mask links, code spans, HTML tags and escapes with same-length filler so
// emStrong/del do not see delimiters inside them. Length-preserving: masked
// positions align with src positions.
function maskInline(src, defs) {
  if (src.indexOf('*') < 0 && src.indexOf('_') < 0 && src.indexOf('~') < 0) return src;
  const n = src.length;
  // Phase A (marked's anyPunctuationOutsideCode): escapes become '+', and
  // the inner backticks of a code span become '+' so the span is clean for
  // the link pattern in phase B. Length-preserving.
  const plus = src.split('');
  {
    let i = 0;
    while (i < n) {
      const c = src[i];
      if (c === '\\' && i + 1 < n && ASCII_PUNCT.has(src[i + 1])) {
        plus[i] = '+'; plus[i + 1] = '+'; i += 2; continue;
      }
      if (c === '`') {
        let m = 1;
        while (src[i + m] === '`') m++;
        const close = findCodeClose(src, i + m, m);
        if (close < 0 || close === i + m) { i += m; continue; }
        for (let k = i + m; k < close; k++) if (plus[k] === '`') plus[k] = '+';
        i = close + m;
        continue;
      }
      i += 1;
    }
  }
  const ptxt = plus.join('');
  // Phase B (marked's blockSkip): mask links, code spans, html spans.
  const out = plus.slice();
  let i = 0;
  while (i < n) {
    const c = ptxt[i];
    if (c === '`') {
      let m = 1;
      while (ptxt[i + m] === '`') m++;
      const close = findCodeClose(ptxt, i + m, m);
      if (close < 0 || close === i + m) { i += m; continue; }
      const end = close + m;
      out[i] = '[';
      for (let k = i + 1; k < end - 1; k++) out[k] = 'a';
      out[end - 1] = ']';
      i = end;
      continue;
    }
    if (c === '[' || (c === '!' && ptxt[i + 1] === '[')) {
      const isImage = c === '!';
      const link = tryLink(ptxt, isImage ? i + 1 : i, defs, isImage);
      if (link) {
        const start = i;
        const end = link.end;
        out[start] = '[';
        for (let k = start + 1; k < end - 1; k++) out[k] = 'a';
        if (end - 1 > start) out[end - 1] = ']';
        i = end;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === '<') {
      const tl = htmlTagLen(ptxt, i);
      if (tl > 0) {
        out[i] = '[';
        for (let k = i + 1; k < i + tl - 1; k++) out[k] = 'a';
        out[i + tl - 1] = ']';
        i += tl;
        continue;
      }
      // Any other <...> span (e.g. an autolink) is masked too, like marked's
      // blockSkip html pattern, so delimiters inside it stay invisible.
      if (ptxt[i + 1] !== ' ') {
        let j = i + 1;
        while (j < n && ptxt[j] !== '>' && ptxt[j] !== '<') j++;
        if (ptxt[j] === '>') {
          out[i] = '[';
          for (let k = i + 1; k < j; k++) out[k] = 'a';
          out[j] = ']';
          i = j + 1;
          continue;
        }
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

// Marked's emStrong at position pos (a * or _ run). Returns
// {end, type, text} or null. masked is the masked src (same length).
function tryEmStrong(src, masked, pos) {
  const m = EM_STRONG_L.exec(src.slice(pos));
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const delimChar = m[0][0];
  const prevChar = pos > 0 ? src[pos - 1] : '';
  const midRun = prevChar === delimChar;
  let runStart = pos;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
  const runPrevChar = runStart > 0 ? ([...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '') : '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || PUNCT_TEST.test(runPrevChar);
  let pc = prevChar;
  if (runStart < pos) pc = runPrevChar;
  const prevPunct = runStart < pos ? runPrevPunct : PUNCT_TEST.test(prevChar);
  if (m[4] && ALNUM_TEST.test(pc)) return null;
  const nextChar = m[1] || m[3] || '';
  if (!nextChar || !pc || prevPunct) {
    const lLength = [...m[0]].length - 1;
    let delimTotal = lLength, midDelimTotal = 0;
    const runLength = pos - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    const endReg = delimChar === '*' ? EM_STRONG_R_AST : EM_STRONG_R_UND;
    const window = masked.slice(pos + lLength);
    if (window.indexOf(delimChar) < 0) return null;
    endReg.lastIndex = 0;
    let match;
    while ((match = endReg.exec(window)) !== null) {
      const rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      let rLength = [...rDelim].length;
      if (match[3] || match[4]) { delimTotal += rLength; continue; }
      else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) { midDelimTotal += rLength; continue; }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const rawEnd = pos + lLength + match.index + lastCharLength + rLength;
      const raw = src.slice(pos, rawEnd);
      if (Math.min(lLength, rLength) % 2) {
        return { end: rawEnd, type: 'em', text: raw.slice(1, -1) };
      }
      return { end: rawEnd, type: 'strong', text: raw.slice(2, -2) };
    }
  }
  return null;
}

// Marked's del at position pos (a ~ run). Returns {end, text} or null.
function tryDel(src, masked, pos) {
  const m = DEL_L.exec(src.slice(pos));
  if (!m) return null;
  const nextChar = m[1] || '';
  const prevChar = pos > 0 ? src[pos - 1] : '';
  if (!nextChar || !prevChar || PUNCT_TEST.test(prevChar)) {
    const lLength = [...m[0]].length - 1;
    let delimTotal = lLength;
    const window = masked.slice(pos + lLength);
    if (window.indexOf('~') < 0) return null;
    DEL_R.lastIndex = 0;
    let match;
    while ((match = DEL_R.exec(window)) !== null) {
      const rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      let rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) { delimTotal += rLength; continue; }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const rawEnd = pos + lLength + match.index + lastCharLength + rLength;
      const raw = src.slice(pos, rawEnd);
      return { end: rawEnd, text: raw.slice(lLength, -lLength) };
    }
  }
  return null;
}

function inlineParse(src, defs, inLink, alt) {
  const parts = [];
  let text = '';
  const flushText = () => { if (text) { parts.push(escText(text)); text = ''; } };
  const pushHtml = (h) => { flushText(); if (h) parts.push(h); };
  const n = src.length;
  let i = 0;
  // Masked source for emStrong/del closer search (links, code, HTML hidden).
  const masked = maskInline(src, defs);

  // Pre-scan GFM extended autolinks over the whole string: an email's local
  // part can contain delimiter chars (_ * ~) that the scanner would otherwise
  // split before the autolink is seen. Autolinks inside code spans or link
  // text are harmless — the main loop jumps over those constructs first.
  const autoAt = new Map();
  let p = 0;
  // No autolinks inside link text (inLink) or alt text: they render as plain
  // text there, and a nested <a> would be wrong.
  while (!alt && !inLink && p < n) {
    const cand = nextAutolinkCand(src, p, n);
    if (cand < 0) break;
    const res = tryExtAutolink(src, cand, n);
    // Advance past the candidate only, not the whole span: an autolink's
    // path can span a link construct (https://x.com)](https://y.com)),
    // and the inner autolink must still be recorded for when the main loop
    // consumes the link first and reaches it separately.
    if (res) { autoAt.set(res.start, res); p = cand + 1; }
    else p = cand + 1;
  }
  const autoStarts = [...autoAt.keys()].sort((a, b) => a - b);
  let ai = 0;

  // Find the next index >= i whose char is special for inline scanning.
  function nextSpecial(from) {
    let j = from;
    while (j < n) {
      const d = src.charCodeAt(j);
      if (d === 92 || d === 96 || d === 42 || d === 95 || d === 126 || d === 91 || d === 33 || d === 60 || d === 10) return j;
      j++;
    }
    return j;
  }

  while (i < n) {
    const auto = autoAt.get(i);
    if (auto) {
      flushText();
      if (alt) parts.push(escText(auto.text));
      else parts.push('<a href="' + cleanUrl(auto.href) + '">' + escText(auto.text) + '</a>');
      i = auto.end;
      while (ai < autoStarts.length && autoStarts[ai] < i) ai++;
      continue;
    }
    const c = src.charCodeAt(i);
    if (c === 92) { // backslash
      const nx = src[i + 1];
      if (nx === '\n') { // hard break
        text = text.replace(/ +$/, '');
        flushText();
        parts.push('<br>');
        i += 2;
        while (src[i] === ' ' || src[i] === '\t') i++;
      } else if (nx !== undefined && ASCII_PUNCT.has(nx)) {
        // An escaped & is literal: it must not start a character reference.
        if (nx === '&') { pushHtml('&amp;'); }
        else text += nx;
        i += 2;
      } else {
        text += '\\';
        i += 1;
      }
      continue;
    }
    if (c === 96) { // backtick: code span
      let m = 1;
      while (src[i + m] === '`') m++;
      const close = findCodeClose(src, i + m, m);
      if (close < 0) {
        text += '`'.repeat(m);
        i += m;
      } else {
        let content = src.slice(i + m, close);
        content = content.replace(/\n/g, ' ');
        if (content.length > 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        pushHtml(alt ? esc(content) : '<code>' + esc(content) + '</code>');
        i = close + m;
      }
      continue;
    }
    if (c === 42 || c === 95) { // * or _ emphasis (marked's emStrong)
      const em = tryEmStrong(src, masked, i);
      if (em) {
        const inner = inlineParse(em.text, defs, inLink, alt);
        pushHtml(alt ? inner : (em.type === 'em' ? '<em>' + inner + '</em>' : '<strong>' + inner + '</strong>'));
        i = em.end;
      } else {
        text += src[i];
        i += 1;
      }
      continue;
    }
    if (c === 126) { // ~ strikethrough (marked's del)
      const d = tryDel(src, masked, i);
      if (d) {
        const inner = inlineParse(d.text, defs, inLink, alt);
        pushHtml(alt ? inner : '<del>' + inner + '</del>');
        i = d.end;
      } else {
        text += '~';
        i += 1;
      }
      continue;
    }
    if (c === 91 || c === 33) { // [ or !
      if (c === 33 && src[i + 1] !== '[') { text += '!'; i += 1; continue; }
      const isImage = c === 33;
      const link = inLink && !isImage ? null : tryLink(src, isImage ? i + 1 : i, defs, isImage);
      if (link) {
        const innerText = src.slice(link.textStart, link.textEnd);
        if (isImage) {
          const altText = inlineParse(innerText, defs, false, true);
          const href = cleanUrl(unescape(link.dest));
          let img = '<img src="' + href + '" alt="' + altText + '"';
          if (link.title) img += ' title="' + escAttr(unescape(link.title)) + '"';
          img += '>';
          pushHtml(alt ? altText : img);
        } else {
          const inner = inlineParse(innerText, defs, true, alt);
          const href = cleanUrl(unescape(link.dest));
          let a = '<a href="' + href + '"';
          if (link.title) a += ' title="' + escAttr(unescape(link.title)) + '"';
          a += '>' + inner + '</a>';
          pushHtml(alt ? inner : a);
        }
        i = link.end;
      } else {
        text += isImage ? '!' : '[';
        i += 1;
      }
      continue;
    }
    if (c === 60) { // < autolink or raw HTML
      const al = tryAutolink(src, i);
      if (al) {
        if (alt) pushHtml(escText(al.text));
        else {
          const href = cleanUrl(al.href);
          pushHtml('<a href="' + href + '">' + escText(al.text) + '</a>');
        }
        i = al.end;
        continue;
      }
      const tagLen = htmlTagLen(src, i);
      if (tagLen > 0) {
        const raw = src.slice(i, i + tagLen);
        pushHtml(alt ? esc(raw) : raw);
        i += tagLen;
        continue;
      }
      text += '<';
      i += 1;
      continue;
    }
    if (c === 10) { // newline: hard break if 2+ spaces precede, else literal newline
      const m = / +$/.exec(text);
      if (m && m[0].length >= 2) {
        text = text.slice(0, text.length - m[0].length);
        flushText();
        parts.push('<br>');
      } else {
        text += '\n';
      }
      i += 1;
      // After a hard break, leading spaces/tabs on the next line are stripped.
      if (m && m[0].length >= 2) {
        while (src[i] === ' ' || src[i] === '\t') i++;
      }
      continue;
    }
    // Plain text run up to the next special char or the next autolink start.
    let j = nextSpecial(i);
    while (ai < autoStarts.length && autoStarts[ai] < i) ai++;
    if (ai < autoStarts.length && autoStarts[ai] < j) j = autoStarts[ai];
    text += src.slice(i, j);
    i = j;
    continue;
  }
  flushText();
  return parts.join('');
}

// ---------------- inline helpers ----------------

function findCodeClose(src, from, len) {
  let j = from;
  const n = src.length;
  while (j < n) {
    const b = src.indexOf('`', j);
    if (b < 0) return -1;
    let m = 1;
    while (src[b + m] === '`') m++;
    if (m === len) return b;
    j = b + m;
  }
  return -1;
}

// Parse an inline link destination+title starting at src[k] === '('.
// Returns {dest, title, end} or null.
function parseInlineDest(src, k) {
  const n = src.length;
  let i = k + 1;
  while (i < n && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n')) i++;
  let dest = '';
  if (src[i] === '<') {
    let j = i + 1;
    while (j < n) {
      if (src[j] === '\\' && j + 1 < n) { j += 2; continue; }
      if (src[j] === '>' || src[j] === '\n' || src[j] === '<') break;
      j++;
    }
    if (src[j] !== '>') return null;
    dest = src.slice(i + 1, j);
    i = j + 1;
  } else {
    let depth = 0;
    let j = i;
    while (j < n) {
      const c = src[j];
      if (c === '\\' && j + 1 < n && ASCII_PUNCT.has(src[j + 1])) { j += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
      if (c === '(') { depth++; j++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--; j++; continue;
      }
      j++;
    }
    dest = src.slice(i, j);
    i = j;
  }
  while (i < n && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n')) i++;
  let title = null;
  if (src[i] === ')') return { dest, title, end: i + 1 };
  const q = src[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    while (j < n) {
      if (src[j] === '\\' && j + 1 < n) { j += 2; continue; }
      if (src[j] === q) break;
      j++;
    }
    if (src[j] !== q) return null;
    title = src.slice(i + 1, j);
    i = j + 1;
  } else if (q === '(') {
    let j = i + 1;
    while (j < n) {
      if (src[j] === '\\' && j + 1 < n) { j += 2; continue; }
      if (src[j] === '(') return null; // no nested parens in a paren title
      if (src[j] === ')') break;
      j++;
    }
    if (src[j] !== ')') return null;
    title = src.slice(i + 1, j);
    i = j + 1;
  } else {
    return null;
  }
  while (i < n && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n')) i++;
  if (src[i] !== ')') return null;
  return { dest, title, end: i + 1 };
}

// Try to parse a link starting at src[open] === '['. Returns
// {textStart, textEnd, dest, title, end} or null.
// isImage: the opener is '![' — images may contain links in their text.
function isEscapedAt(src, pos) {
  let k = pos - 1, count = 0;
  while (k >= 0 && src[k] === '\\') { count++; k--; }
  return count % 2 === 1;
}

function tryLink(src, open, defs, isImage) {
  const n = src.length;
  let depth = 0;
  let j = open + 1;
  let textEnd = -1;
  while (j < n) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') {
      // Skip a code span: a ] inside it does not close the link text.
      // Marked's label regex does not require the closing run to match the
      // opening run's length — any following backtick run closes the skip.
      let m = 1;
      while (src[j + m] === '`') m++;
      const nk = src.indexOf('`', j + m);
      if (nk < 0) {
        // No closer: only a 2+ run immediately before ] can be skipped.
        if (m >= 2 && src[j + m] === ']') { j += m; continue; }
        return null;
      }
      let m2 = 1;
      while (src[nk + m2] === '`') m2++;
      j = nk + m2;
      continue;
    }
    if (c === '<') {
      // Skip an autolink or HTML tag: a ] inside it does not close the text.
      const al = tryAutolink(src, j);
      if (al) { j = al.end; continue; }
      const tl = htmlTagLen(src, j);
      if (tl > 0) { j += tl; continue; }
      j++;
      continue;
    }
    if (c === '[') {
      // A nested link inside link text blocks the outer link (the inner one
      // wins). Images may contain links, and links may contain images — so an
      // image and its following ref label or (dest) are skipped whole.
      if (src[j - 1] === '!' && !isEscapedAt(src, j - 1)) {
        // Skip the image's text brackets, then its ref/dest if present.
        let d2 = 1;
        let k2 = j + 1;
        while (k2 < n && d2 > 0) {
          if (src[k2] === '\\') { k2 += 2; continue; }
          if (src[k2] === '[') d2++;
          else if (src[k2] === ']') d2--;
          k2++;
        }
        if (src[k2] === '[') {
          let d3 = 1;
          k2++;
          while (k2 < n && d3 > 0) {
            if (src[k2] === '\\') { k2 += 2; continue; }
            if (src[k2] === '[') d3++;
            else if (src[k2] === ']') d3--;
            k2++;
          }
        } else if (src[k2] === '(') {
          let d3 = 1;
          k2++;
          while (k2 < n && d3 > 0) {
            if (src[k2] === '\\') { k2 += 2; continue; }
            if (src[k2] === '(') d3++;
            else if (src[k2] === ')') d3--;
            k2++;
          }
        }
        j = k2;
        continue;
      }
      if (!isImage) {
        if (tryLink(src, j, defs, false)) return null;
      }
      depth++; j++; continue;
    }
    if (c === ']') {
      if (depth === 0) { textEnd = j; break; }
      depth--; j++; continue;
    }
    j++;
  }
  if (textEnd < 0) return null;
  const textStart = open + 1;
  const k = textEnd + 1;
  if (src[k] === '(') {
    const inl = parseInlineDest(src, k);
    if (inl) return { textStart, textEnd, dest: inl.dest, title: inl.title, end: inl.end };
    // A failed inline link falls back to a shortcut reference.
    const label = normLabel(src.slice(textStart, textEnd));
    if (!label) return null;
    const def = defs.get(label);
    if (!def) return null;
    return { textStart, textEnd, dest: def.href, title: def.title, end: textEnd + 1 };
  }
  if (src[k] === '[') {
    let l = k + 1;
    let labelEnd = -1;
    while (l < n) {
      const c = src[l];
      if (c === '\\') { l += 2; continue; }
      if (c === '[') return null; // ref labels cannot contain brackets
      if (c === ']') { labelEnd = l; break; }
      l++;
    }
    if (labelEnd < 0) return null;
    let label;
    if (labelEnd === k + 1) label = normLabel(src.slice(textStart, textEnd));
    else label = normLabel(src.slice(k + 1, labelEnd));
    if (!label) return null;
    const def = defs.get(label);
    if (!def) return null;
    return { textStart, textEnd, dest: def.href, title: def.title, end: labelEnd + 1 };
  }
  const label = normLabel(src.slice(textStart, textEnd));
  if (!label) return null;
  const def = defs.get(label);
  if (!def) return null;
  return { textStart, textEnd, dest: def.href, title: def.title, end: textEnd + 1 };
}

const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

// Autolink <scheme:...> or <email> at src[i] === '<'. Returns {href, text, end} or null.
function tryAutolink(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n && src[j] !== '>' && src[j] !== ' ' && src[j] !== '\n' && src[j] !== '<') j++;
  if (src[j] !== '>') return null;
  const inner = src.slice(i + 1, j);
  if (!inner) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(inner)) {
    return { href: inner, text: inner, end: j + 1 };
  }
  if (EMAIL_RE.test(inner)) {
    return { href: 'mailto:' + inner, text: inner, end: j + 1 };
  }
  return null;
}

// Length of the raw HTML tag starting at src[i] === '<', or 0 if not a tag.
function htmlTagLen(src, i) {
  const n = src.length;
  if (src.startsWith('<!--', i)) {
    if (src.startsWith('<!-->', i)) return 5;
    if (src.startsWith('<!--->', i)) return 6;
    const e = src.indexOf('-->', i + 4);
    return e >= 0 ? e + 3 - i : 0;
  }
  if (src.startsWith('<?', i)) {
    const e = src.indexOf('?>', i + 2);
    return e >= 0 ? e + 2 - i : 0;
  }
  if (src.startsWith('<![CDATA[', i)) {
    const e = src.indexOf(']]>', i + 9);
    return e >= 0 ? e + 3 - i : 0;
  }
  if (src.startsWith('<!', i)) {
    if (i + 2 < n && /[A-Za-z]/.test(src[i + 2])) {
      const e = src.indexOf('>', i + 2);
      return e >= 0 ? e + 1 - i : 0;
    }
    return 0;
  }
  let j = i + 1;
  const closing = src[j] === '/';
  if (closing) j++;
  if (j >= n || !/[a-zA-Z]/.test(src[j])) return 0;
  j++;
  while (j < n && /[a-zA-Z0-9-]/.test(src[j])) j++;
  if (closing) {
    while (j < n && /\s/.test(src[j])) j++;
    return src[j] === '>' ? j + 1 - i : 0;
  }
  while (true) {
    const wsStart = j;
    while (j < n && /\s/.test(src[j])) j++;
    const hadWS = j > wsStart;
    if (j >= n) return 0;
    if (src[j] === '>') return j + 1 - i;
    if (src[j] === '/' && src[j + 1] === '>') return j + 2 - i;
    if (src[j] === '/') return 0;
    if (!hadWS) return 0;
    if (!/[a-zA-Z_:]/.test(src[j])) return 0;
    j++;
    while (j < n && /[a-zA-Z0-9_.:-]/.test(src[j])) j++;
    const nameEnd = j;
    let k = j;
    while (k < n && /\s/.test(src[k])) k++;
    if (src[k] === '=') {
      k++;
      while (k < n && /\s/.test(src[k])) k++;
      if (src[k] === '"') {
        k++;
        while (k < n && src[k] !== '"') k++;
        if (k >= n) return 0;
        k++;
      } else if (src[k] === "'") {
        k++;
        while (k < n && src[k] !== "'") k++;
        if (k >= n) return 0;
        k++;
      } else {
        if (k >= n || /[\s"'=<>`]/.test(src[k])) return 0;
        while (k < n && !/[\s"'=<>`]/.test(src[k])) k++;
      }
      j = k;
    } else {
      j = nameEnd;
    }
  }
}

// ---------------- GFM extended autolinks ----------------

function nextAutolinkCand(src, from, to) {
  let best = -1;
  const w = src.indexOf('www.', from);
  if (w >= 0 && w < to) best = w;
  const s = src.indexOf(':', from);
  if (s >= 0 && s < to && (best < 0 || s < best)) best = s;
  const a = src.indexOf('@', from);
  if (a >= 0 && a < to && (best < 0 || a < best)) best = a;
  return best;
}

const BACKPEDAL = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
// Trim an autolink path the way marked does: apply the backpedal regex until
// it stops changing. Balanced (...) groups are kept whole; trailing
// punctuation and &entity; are dropped.
function trimAutolink(s) {
  let prev, cur = s;
  do {
    prev = cur;
    cur = BACKPEDAL.exec(cur)?.[0] ?? '';
  } while (prev !== cur);
  return cur.length;
}

function isAutolinkBoundary(src, pos) {
  // char before pos must be start, whitespace, or * _ ~ (
  if (pos <= 0) return true;
  const c = src[pos - 1];
  return c === ' ' || c === '\t' || c === '\n' || c === '*' || c === '_' || c === '~' || c === '(';
}

function isLabelChar(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-'; }

// Try a GFM extended autolink at candidate position cand (index of 'www.', '://' or '@').
// Returns {start, end, href, text} or null.
function tryExtAutolink(src, cand, to) {
  const n = src.length;
  if (src.startsWith('www.', cand)) {
    if (!isAutolinkBoundary(src, cand)) return null;
    // domain: labels after www., at least one dot
    let j = cand + 4;
    let labels = 0;
    let dots = 0;
    while (j < n) {
      const ls = j;
      while (j < n && isLabelChar(src[j])) j++;
      if (j === ls) break;
      if (src[ls] === '-' || src[j - 1] === '-') return null;
      labels++;
      if (src[j] === '.') { dots++; j++; continue; }
      break;
    }
    if (labels < 2 || dots < 1) return null;
    // path: extend to whitespace or '<'
    let end = j;
    while (end < n && src[end] !== ' ' && src[end] !== '\t' && src[end] !== '\n' && src[end] !== '<') end++;
    end = cand + trimAutolink(src.slice(cand, end));
    if (end <= cand) return null;
    const text = src.slice(cand, end);
    return { start: cand, end, href: 'http://' + text, text };
  }
  if (src[cand] === ':') {
    // Scheme before cand: scheme://path (any scheme), or mailto:/xmpp: + email.
    let s = cand - 1;
    while (s >= 0 && /[a-zA-Z0-9+.-]/.test(src[s])) s--;
    s++;
    const scheme = src.slice(s, cand);
    if (scheme.length < 2 || scheme.length > 32 || !/[a-zA-Z]/.test(scheme[0])) return null;
    if (src[cand + 1] === '/' && src[cand + 2] === '/') {
      let end = cand + 3;
      if (end >= n || src[end] === ' ' || src[end] === '\t' || src[end] === '\n' || src[end] === '<') return null;
      while (end < n && src[end] !== ' ' && src[end] !== '\t' && src[end] !== '\n' && src[end] !== '<') end++;
      end = s + trimAutolink(src.slice(s, end));
      if (end <= cand + 3) return null;
      const text = src.slice(s, end);
      return { start: s, end, href: text, text };
    }
    const low = scheme.toLowerCase();
    if (low !== 'mailto' && low !== 'xmpp') return null;
    // mailto:/xmpp: + email address (xmpp allows one /segment after it)
    let at = cand + 1;
    while (at < n && src[at] !== '@' && src[at] !== ' ' && src[at] !== '\t' && src[at] !== '\n' && src[at] !== '<' && src[at] !== '/') at++;
    if (src[at] !== '@') return null;
    const em = tryEmailAt(src, at, n, true);
    if (!em) return null;
    let end = em.end;
    if (low === 'xmpp' && src[end] === '/') {
      let se = end + 1;
      while (se < n && src[se] !== ' ' && src[se] !== '\t' && src[se] !== '\n' && src[se] !== '<' && src[se] !== '/' && src[se] !== '?' && src[se] !== '#' && src[se] !== ';') se++;
      if (se > end + 1) end = se;
    }
    end = s + trimAutolink(src.slice(s, end));
    if (end <= cand) return null;
    const text = src.slice(s, end);
    return { start: s, end, href: text, text };
  }
  // '@' email
  const em = tryEmailAt(src, cand, n);
  if (!em) return null;
  return em;
}

// Parse an email address whose '@' is at src[at]. Returns {start, end, href, text} or null.
function tryEmailAt(src, at, n, skipBoundary) {
  let s = at - 1;
  while (s >= 0 && /[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(src[s])) s--;
  s++;
  if (s >= at) return null;
  if (!skipBoundary && !isAutolinkBoundary(src, s)) return null;
  let j = at + 1;
  let labels = 0;
  let dots = 0;
  let lastEnd = j;
  while (j < n) {
    const ls = j;
    while (j < n && isLabelChar(src[j])) j++;
    if (j === ls) break;
    if (src[ls] === '-' || src[j - 1] === '-') return null;
    labels++;
    lastEnd = j;
    if (src[j] === '.') { dots++; j++; continue; }
    break;
  }
  if (labels < 2 || dots < 1) return null;
  j = lastEnd;
  // The char after the domain must not be a word char (else no autolink).
  if (j < n) {
    const nc = src[j];
    if ((nc >= 'a' && nc <= 'z') || (nc >= 'A' && nc <= 'Z') || (nc >= '0' && nc <= '9') || nc === '_' || nc === '-') return null;
  }
  const text = src.slice(s, j);
  return { start: s, end: j, href: 'mailto:' + text, text };
}

// ---------------- block parsing ----------------

function indentInfo(line) {
  let col = 0, idx = 0;
  while (idx < line.length) {
    const c = line[idx];
    if (c === ' ') { col++; idx++; }
    else if (c === '\t') { col += 4 - (col % 4); idx++; }
    else break;
  }
  return [col, idx];
}

function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

function stripCols(line, cols) {
  let col = 0, idx = 0;
  while (idx < line.length && col < cols) {
    const c = line[idx];
    if (c === ' ') { col++; idx++; }
    else if (c === '\t') {
      const adv = 4 - (col % 4);
      if (col + adv > cols) return ' '.repeat(col + adv - cols) + line.slice(idx + 1);
      col += adv; idx++;
    } else break;
  }
  return line.slice(idx);
}

// Expand the leading whitespace of line[idx..] (starting at column col) into
// spaces, preserving columns. Used when a stripped line is re-parsed as
// markdown (list/quote content), where a surviving tab would expand against
// the wrong column base.
function expandFrom(line, idx, col) {
  let out = '';
  let c = col;
  let k = idx;
  while (k < line.length) {
    const ch = line[k];
    if (ch === ' ') { out += ' '; c++; k++; }
    else if (ch === '\t') { const adv = 4 - (c % 4); out += ' '.repeat(adv); c += adv; k++; }
    else break;
  }
  return out + line.slice(k);
}

// Slice a line at a column boundary, advancing through any characters
// (used for a list item's first line, where the marker is non-whitespace),
// expanding any surviving leading tabs to spaces.
function sliceAtCol(line, cols) {
  let col = 0, idx = 0;
  while (idx < line.length && col < cols) {
    const c = line[idx];
    if (c === '\t') {
      const adv = 4 - (col % 4);
      if (col + adv > cols) return ' '.repeat(col + adv - cols) + expandFrom(line, idx + 1, col + adv);
      col += adv; idx++;
    } else { col++; idx++; }
  }
  return expandFrom(line, idx, col);
}

// Like stripCols, but expands surviving leading tabs to spaces (for content
// lines that are re-parsed as markdown, e.g. list item bodies).
function stripColsExpand(line, cols) {
  let col = 0, idx = 0;
  while (idx < line.length && col < cols) {
    const c = line[idx];
    if (c === ' ') { col++; idx++; }
    else if (c === '\t') {
      const adv = 4 - (col % 4);
      if (col + adv > cols) return ' '.repeat(col + adv - cols) + expandFrom(line, idx + 1, col + adv);
      col += adv; idx++;
    } else break;
  }
  return expandFrom(line, idx, col);
}

function isSetextLine(line) {
  const [col, idx] = indentInfo(line);
  if (col > 3) return 0;
  const ch = line[idx];
  if (ch !== '=' && ch !== '-') return 0;
  let j = idx;
  while (line[j] === ch) j++;
  while (line[j] === ' ' || line[j] === '\t') j++;
  if (j !== line.length) return 0;
  return ch === '=' ? 1 : 2;
}

function isHRLine(line) {
  const [col, idx] = indentInfo(line);
  if (col > 3) return false;
  const ch = line[idx];
  if (ch !== '-' && ch !== '*' && ch !== '_') return false;
  let count = 0, j = idx;
  while (j < line.length) {
    const c = line[j];
    if (c === ch) { count++; j++; }
    else if (c === ' ' || c === '\t') j++;
    else return false;
  }
  return count >= 3;
}

function isATXStart(line) {
  const [col, idx] = indentInfo(line);
  if (col > 3) return false;
  let j = idx, level = 0;
  while (line[j] === '#') { level++; j++; }
  if (level === 0 || level > 6) return false;
  return j >= line.length || line[j] === ' ' || line[j] === '\t';
}

function isFenceStart(line) {
  const [col, idx] = indentInfo(line);
  if (col > 3) return false;
  const ch = line[idx];
  if (ch !== '`' && ch !== '~') return false;
  let m = 0;
  while (line[idx + m] === ch) m++;
  if (m < 3) return false;
  if (ch === '`') {
    const info = line.slice(idx + m);
    if (info.indexOf('`') >= 0) return false;
  }
  return true;
}

// Parse a list marker at the start of line. Returns null or
// {ordered, bullet, delim, num, markerEnd, contentIndent, empty}
function listMarker(line) {
  const [col, idx] = indentInfo(line);
  if (col > 3) return null;
  let j = idx;
  const c = line[j];
  let ordered = false, bullet = null, delim = null, num = 0;
  if (c === '-' || c === '+' || c === '*') {
    bullet = c;
    j++;
  } else if (c >= '0' && c <= '9') {
    let digits = 0;
    let v = 0;
    while (line[j] >= '0' && line[j] <= '9' && digits < 10) { v = v * 10 + (line[j].charCodeAt(0) - 48); j++; digits++; }
    if (digits === 0 || digits > 9) return null;
    if (line[j] !== '.' && line[j] !== ')') return null;
    delim = line[j];
    j++;
    ordered = true;
    num = v;
  } else {
    return null;
  }
  // after the marker: whitespace (or EOL)
  if (j >= line.length) {
    return { ordered, bullet, delim, num, markerEnd: j, contentIndent: col + (j - idx) + 1, empty: true };
  }
  const after = line[j];
  if (after !== ' ' && after !== '\t') return null;
  // measure the whitespace run in columns
  let k = j;
  let spaces = 0;
  let startCol = col + (j - idx);
  let curCol = startCol;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    if (line[k] === ' ') { curCol++; spaces++; }
    else { const adv = 4 - (curCol % 4); curCol += adv; spaces += adv; }
    k++;
  }
  if (k >= line.length) {
    // marker + only whitespace: empty item
    return { ordered, bullet, delim, num, markerEnd: j, contentIndent: startCol + 1, empty: true };
  }
  let contentIndent;
  if (spaces >= 1 && spaces <= 4) contentIndent = curCol;
  else contentIndent = startCol + 1;
  return { ordered, bullet, delim, num, markerEnd: j, contentIndent, empty: false };
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

// HTML block start at line. Returns 0 (none) or the type 1-7.
function htmlBlockType(line) {
  const [col, idx] = indentInfo(line);
  if (col > 3) return 0;
  const rest = line.slice(idx);
  const m1 = /^<(script|pre|style|textarea)([\s>]|$)/i.exec(rest);
  if (m1) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![A-Za-z]/.test(rest)) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  const m6 = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)(?=[\s>\/]|$)/.exec(rest);
  if (m6) {
    // Type 6: a block tag name followed by a boundary. The tag itself may
    // continue on later lines (e.g. `<div id="foo"` with no `>` yet).
    const name = m6[1].toLowerCase();
    if (BLOCK_TAGS.has(name)) return 6;
  }
  // type 7: any other complete tag alone on the line (validated like inline
  // HTML: closing tags take no attributes, attributes need whitespace).
  const tlen = htmlTagLen(line, idx);
  if (tlen > 0 && /^[ \t]*$/.test(line.slice(idx + tlen))) return 7;
  return 0;
}

// Does this line start a block that interrupts a paragraph? (ATX, fence, HR, quote,
// list, HTML types 1-6.) Used for paragraph continuation and lazy lines.
function interruptsPara(line, inPara, inItem) {
  const [col, idx] = indentInfo(line);
  if (col > 3) return false;
  if (isATXStart(line) || isFenceStart(line) || isHRLine(line)) return true;
  if (line[idx] === '>') return true;
  const m = listMarker(line);
  if (m) {
    if (!m.ordered) return !m.empty;
    // Inside a list item's content, ANY ordered list interrupts a paragraph;
    // elsewhere only a list starting at 1 does.
    return inItem ? !m.empty : (m.num === 1 && !m.empty);
  }
  const ht = htmlBlockType(line);
  if (ht >= 1 && ht <= 6) return true;
  return false;
}

class Blocks {
  constructor(lines, defs, srcEndsWithNL, inItem) {
    this.lines = lines;
    this.defs = defs;
    this.srcEndsWithNL = srcEndsWithNL;
    this.inItem = !!inItem;
    this.i = 0;
    this.out = [];
  }

  parse() {
    const L = this.lines;
    let seenBlock = false;
    let blankSinceBlock = false;
    this.hadBlankBetween = false;
    while (this.i < L.length) {
      if (isBlank(L[this.i])) {
        if (seenBlock) blankSinceBlock = true;
        this.i++;
        continue;
      }
      if (blankSinceBlock && seenBlock) this.hadBlankBetween = true;
      blankSinceBlock = false;
      if (this.tryATX()) { seenBlock = true; continue; }
      if (this.tryFence()) { seenBlock = true; continue; }
      if (this.tryHR()) { seenBlock = true; continue; }
      if (this.tryQuote()) { seenBlock = true; continue; }
      if (this.tryList()) { seenBlock = true; continue; }
      if (this.tryHtml()) { seenBlock = true; continue; }
      if (this.tryIndentedCode()) { seenBlock = true; continue; }
      this.tryParagraph();
      seenBlock = true;
    }
    return this.out;
  }

  tryATX() {
    const line = this.lines[this.i];
    const [col, idx] = indentInfo(line);
    if (col > 3) return false;
    let j = idx, level = 0;
    while (line[j] === '#') { level++; j++; }
    if (level === 0 || level > 6) return false;
    if (j < line.length && line[j] !== ' ' && line[j] !== '\t') return false;
    let content = line.slice(j).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    if (/^#+$/.test(content)) content = '';
    else content = content.replace(/[ \t]+#+$/, '');
    this.out.push({ t: 'h', level, text: content });
    this.i++;
    return true;
  }

  tryFence() {
    const line = this.lines[this.i];
    const [col, idx] = indentInfo(line);
    if (col > 3) return false;
    const ch = line[idx];
    if (ch !== '`' && ch !== '~') return false;
    let m = 0;
    while (line[idx + m] === ch) m++;
    if (m < 3) return false;
    const info = line.slice(idx + m).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    if (ch === '`' && info.indexOf('`') >= 0) return false;
    const lang = info ? unescape(info.split(/[ \t]/, 1)[0]) : null;
    const content = [];
    let j = this.i + 1;
    while (j < this.lines.length) {
      const l = this.lines[j];
      const [cc, ci] = indentInfo(l);
      if (cc <= 3 && l[ci] === ch) {
        let m2 = 0;
        while (l[ci + m2] === ch) m2++;
        if (m2 >= m && /^[ \t]*$/.test(l.slice(ci + m2))) { j++; break; }
      }
      content.push(stripCols(l, col));
      j++;
    }
    // No trailing newline is added when the last content line is blank.
    const ftext = content.length ? content.join('\n') + (content[content.length - 1] === '' ? '' : '\n') : '';
    this.out.push({ t: 'code', lang, text: ftext });
    this.i = j;
    return true;
  }

  tryHR() {
    if (!isHRLine(this.lines[this.i])) return false;
    this.out.push({ t: 'hr' });
    this.i++;
    return true;
  }

  tryQuote() {
    const line = this.lines[this.i];
    const [col, idx] = indentInfo(line);
    if (col > 3 || line[idx] !== '>') return false;
    const inner = [];
    const ps = { inPara: false, fence: null };
    let j = this.i;
    const L = this.lines;
    while (j < L.length) {
      const l = L[j];
      const [cc, ci] = indentInfo(l);
      if (cc <= 3 && l[ci] === '>') {
        let k = ci + 1;
        let col = cc + 1;
        let stripped;
        if (l[k] === ' ') { stripped = expandFrom(l, k + 1, col + 1); }
        else if (l[k] === '\t') {
          const adv = 4 - (col % 4);
          stripped = ' '.repeat(adv - 1) + expandFrom(l, k + 1, col + adv);
        } else stripped = l.slice(k);
        inner.push(stripped);
        quoteParaState(stripped, ps);
        j++;
        continue;
      }
      // A blank line without a marker ends the quote (marked does not merge
      // quote blocks across blank lines).
      if (isBlank(l)) break;
      if (!ps.inPara) break;
      // A list marker line ends the quote — it is never a lazy continuation.
      if (listMarker(l)) break;
      if (interruptsPara(l, true)) break;
      // A lazy line loses its leading whitespace; a lazy setext underline is
      // kept as literal text, indented by marked. The LAZY sentinel keeps the
      // inner parse from re-reading the stripped line as a block start.
      const lstripped = l.replace(/^[ \t]+/, '');
      inner.push(LAZY + (isSetextLine(lstripped) ? '    ' + lstripped : lstripped));
      j++;
    }
    const innerEndsNL = (j - 1 === L.length - 1) && this.srcEndsWithNL;
    const sub = new Blocks(inner, this.defs, innerEndsNL);
    this.out.push({ t: 'q', children: sub.parse() });
    this.i = j;
    return true;
  }

  tryList() {
    const m = listMarker(this.lines[this.i]);
    if (!m) return false;
    const ordered = m.ordered;
    const items = [];
    let loose = false;
    let j = this.i;
    const L = this.lines;
    let first = true;
    let pendingBlank = false;
    while (j < L.length) {
      const l = L[j];
      const m2 = listMarker(l);
      if (m2 && !isHRLine(l) && m2.ordered === ordered && (ordered ? m2.delim === m.delim : m2.bullet === m.bullet)) {
        if (!first && pendingBlank) loose = true;
        const it = this.parseListItem(j, m2);
        if (it.hadInnerBlank) loose = true;
        items.push(it.item);
        j = it.next;
        pendingBlank = it.endsWithBlank;
        first = false;
        continue;
      }
      if (isBlank(l)) {
        // blank line: peek for another item of this list
        let p = j + 1;
        while (p < L.length && isBlank(L[p])) p++;
        if (p < L.length) {
          const m3 = listMarker(L[p]);
          if (m3 && !isHRLine(L[p]) && m3.ordered === ordered && (ordered ? m3.delim === m.delim : m3.bullet === m.bullet)) {
            pendingBlank = true;
            j = p;
            continue;
          }
        }
        break;
      }
      break;
    }
    this.out.push({ t: 'list', ordered, start: ordered ? m.num : 0, loose, items });
    this.i = j;
    return true;
  }

  // Parse one list item starting at line startIdx with marker m.
  // Returns {item, next, hadInnerBlank, endsWithBlank}.
  parseListItem(startIdx, m) {
    const L = this.lines;
    const ci = m.contentIndent;
    const content = [];
    const ps = { inPara: false, fence: null };
    let hadInnerBlank = false;
    let endsWithBlank = false;
    // first line: content after the marker
    const firstLine = L[startIdx];
    let firstContent;
    if (m.empty) {
      firstContent = '';
    } else {
      firstContent = sliceAtCol(firstLine, ci);
    }
    content.push(firstContent);
    quoteParaState(firstContent, ps);
    // An empty item followed by a blank line stays empty: following indented
    // content belongs outside the list.
    if (m.empty && startIdx + 1 < L.length && isBlank(L[startIdx + 1])) {
      return { item: { task: false, checked: false, children: [] }, next: startIdx + 1, hadInnerBlank: false, endsWithBlank: true };
    }
    let j = startIdx + 1;
    let lastBlankRun = 0;
    while (j < L.length) {
      const l = L[j];
      if (isBlank(l)) {
        // tentatively include; decide when we see what follows
        let p = j + 1;
        while (p < L.length && isBlank(L[p])) p++;
        if (p >= L.length) { endsWithBlank = true; j = p; break; }
        const l2 = L[p];
        const [c2] = indentInfo(l2);
        const mNext = listMarker(l2);
        // A list marker at indent < ci is a sibling item (ends this item);
        // at indent >= ci it is a nested list inside this item.
        if (mNext && c2 < ci) { endsWithBlank = true; j = j; break; }
        if (c2 >= ci) {
          // more indented content follows: blanks belong to the item
          while (j < p) { content.push(''); j++; }
          ps.inPara = false;
          continue;
        }
        // not part of the item
        endsWithBlank = true;
        break;
      }
      const [c2] = indentInfo(l);
      // When a fence is open inside the item, lines belong to the item as
      // fence content regardless of indent (until the fence closes).
      if (ps.fence) {
        const stripped = stripColsExpand(l, ci);
        content.push(stripped);
        quoteParaState(stripped, ps);
        j++;
        continue;
      }
      if (c2 >= ci) {
        const stripped = stripColsExpand(l, ci);
        content.push(stripped);
        quoteParaState(stripped, ps);
        j++;
        continue;
      }
      // A list marker line ends this item (it starts a new item, handled by
      // the outer loop) — it is never a lazy continuation.
      if (listMarker(l)) break;
      // lazy continuation?
      if (ps.inPara && !interruptsPara(l, true)) {
        const lstripped = l.replace(/^[ \t]+/, '');
        content.push(LAZY + (isSetextLine(lstripped) ? '    ' + lstripped : lstripped));
        j++;
        continue;
      }
      break;
    }
    // drop trailing blank content lines
    while (content.length > 1 && content[content.length - 1] === '') content.pop();
    if (content.length === 1 && content[0] === '') {
      // empty item
      return { item: { task: false, checked: false, children: [] }, next: j, hadInnerBlank, endsWithBlank };
    }
    // task list check on the first non-blank content line
    let task = false, checked = false;
    for (let k = 0; k < content.length; k++) {
      if (content[k] === '') continue;
      const tm = /^\[([ xX])\][ \t]+/.exec(content[k]);
      if (tm) {
        task = true;
        checked = tm[1] === 'x' || tm[1] === 'X';
        content[k] = content[k].slice(tm[0].length);
      }
      break;
    }
    const innerEndsNL = (j - 1 === L.length - 1) && this.srcEndsWithNL && !endsWithBlank;
    const sub = new Blocks(content, this.defs, innerEndsNL, true);
    const children = sub.parse();
    // Looseness comes from blank lines between this item's own top-level
    // blocks, not from blanks nested deeper (inside a sub-list or a fence).
    if (sub.hadBlankBetween) hadInnerBlank = true;
    return { item: { task, checked, children }, next: j, hadInnerBlank, endsWithBlank };
  }

  tryHtml() {
    const line = this.lines[this.i];
    const type = htmlBlockType(line);
    if (type === 0) return false;
    const L = this.lines;
    let j = this.i;
    let endIdx = j;
    if (type === 1) {
      const name = /^<(script|pre|style|textarea)([\s>]|$)/i.exec(line.slice(indentInfo(line)[1]))[1].toLowerCase();
      const endRe = new RegExp('</' + name + '(?=[\\s>/]|$)', 'i');
      while (j < L.length) {
        endIdx = j;
        if (endRe.test(L[j])) { j++; break; }
        j++;
      }
    } else if (type === 2) {
      while (j < L.length) {
        endIdx = j;
        if (L[j].indexOf('-->') >= 0) { j++; break; }
        j++;
      }
    } else if (type === 3) {
      while (j < L.length) {
        endIdx = j;
        if (L[j].indexOf('?>') >= 0) { j++; break; }
        j++;
      }
    } else if (type === 4) {
      while (j < L.length) {
        endIdx = j;
        if (L[j].indexOf('>') >= 0) { j++; break; }
        j++;
      }
    } else if (type === 5) {
      while (j < L.length) {
        endIdx = j;
        if (L[j].indexOf(']]>') >= 0) { j++; break; }
        j++;
      }
    } else {
      while (j < L.length && !isBlank(L[j])) { endIdx = j; j++; }
    }
    let text = L.slice(this.i, endIdx + 1).join('\n');
    // Types 1-5 end at the end-sequence line and keep its trailing newline
    // whenever one follows in the source; types 6-7 end at a blank line and
    // keep a trailing newline only at end of input.
    if (type <= 5) {
      if ((endIdx < L.length - 1 && !isBlank(L[endIdx + 1])) || (endIdx === L.length - 1 && this.srcEndsWithNL)) text += '\n';
    } else if (endIdx === L.length - 1 && this.srcEndsWithNL) {
      text += '\n';
    }
    this.out.push({ t: 'html', text });
    this.i = j;
    return true;
  }

  tryIndentedCode() {
    const line = this.lines[this.i];
    const [col] = indentInfo(line);
    if (col < 4) return false;
    const content = [];
    const L = this.lines;
    let j = this.i;
    while (j < L.length) {
      const l = L[j];
      if (isBlank(l)) {
        let k = j + 1;
        while (k < L.length && isBlank(L[k])) k++;
        if (k < L.length && indentInfo(L[k])[0] >= 4) {
          while (j < k) { content.push(stripCols(L[j], 4)); j++; }
          continue;
        }
        break;
      }
      if (indentInfo(l)[0] < 4) break;
      content.push(stripCols(l, 4));
      j++;
    }
    this.out.push({ t: 'code', lang: null, text: content.join('\n') + '\n' });
    this.i = j;
    return true;
  }
}

// Heuristic: after this (container-stripped) line, is a paragraph open inside
// the container? prevInPara is the state before this line (an indented line
// continues an open paragraph, but starts code when none is open).
// Fence info for a line: {ch, len} or null.
function fenceInfo(line) {
  const [col, idx] = indentInfo(line);
  if (col > 3) return null;
  const ch = line[idx];
  if (ch !== '`' && ch !== '~') return null;
  let m = 0;
  while (line[idx + m] === ch) m++;
  if (m < 3) return null;
  if (ch === '`' && line.slice(idx + m).indexOf('`') >= 0) return null;
  return { ch, len: m };
}

// Tracks whether the inner content of a quote/list item currently ends with
// an open paragraph (lazy continuations allowed) and whether a fence is open.
// st = {inPara, fence}; mutated in place.
function quoteParaState(line, st) {
  if (isBlank(line)) { st.inPara = false; return; }
  // Strip leading quote markers to see the innermost content.
  let s = line;
  while (true) {
    const [c, idx] = indentInfo(s);
    if (c > 3 || s[idx] !== '>') break;
    s = s.slice(idx + 1);
    if (s[0] === ' ' || s[0] === '\t') s = s.slice(1);
    if (s === '') { st.inPara = false; return; }
  }
  // Fence tracking on the line as gathered (nested '>' markers intact): a
  // fence line inside a nested quote is content, not a close. While a fence
  // is open, no paragraph is open.
  if (st.fence) {
    const [col, idx] = indentInfo(line);
    if (col <= 3 && line[idx] === st.fence.ch) {
      let m = 0;
      while (line[idx + m] === st.fence.ch) m++;
      if (m >= st.fence.len && /^[ \t]*$/.test(line.slice(idx + m))) st.fence = null;
    }
    st.inPara = false;
    return;
  }
  const fi = fenceInfo(line);
  if (fi) { st.fence = fi; st.inPara = false; return; }
  if (isBlank(s)) { st.inPara = false; return; }
  const [col, idx] = indentInfo(s);
  if (col > 3) return; // keep prev inPara
  if (isATXStart(s) || isHRLine(s)) { st.inPara = false; return; }
  if (s[idx] === '>') { st.inPara = false; return; }
  const m = listMarker(s);
  if (m) { st.inPara = !m.empty; return; }
  const ht = htmlBlockType(s);
  if (ht >= 1 && ht <= 6) { st.inPara = false; return; }
  if (isSetextLine(s)) { st.inPara = false; return; }
  st.inPara = true;
}

// ---------------- link reference definitions ----------------

function parseTitle(text, i, q) {
  const close = q === '(' ? ')' : q;
  let k = i + 1;
  while (k < text.length) {
    if (text[k] === '\\' && k + 1 < text.length) { k += 2; continue; }
    if (text[k] === close) return { title: text.slice(i + 1, k), end: k + 1 };
    if (q === '(' && text[k] === '(') return null;
    k++;
  }
  return null;
}

// Try to parse a link reference definition starting at text[pos].
// Returns {label, dest, title, end} or null.
function tryParseDef(text, pos) {
  let i = pos;
  let spaces = 0;
  while (text[i] === ' ' && spaces < 3) { i++; spaces++; }
  if (text[i] !== '[') return null;
  let j = i + 1;
  let label = '';
  while (j < text.length) {
    const c = text[j];
    if (c === '\\' && j + 1 < text.length) { label += text[j] + text[j + 1]; j += 2; continue; }
    if (c === '[') return null; // labels cannot contain unescaped brackets
    if (c === ']') break;
    label += c; j++;
  }
  if (text[j] !== ']' || !label.trim() || label.length > 999) return null;
  j++;
  if (text[j] !== ':') return null;
  j++;
  while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
  let dest = '';
  if (text[j] === '<') {
    let k = j + 1;
    while (k < text.length) {
      if (text[k] === '\\' && k + 1 < text.length) { k += 2; continue; }
      if (text[k] === '>' || text[k] === '\n' || text[k] === '<') break;
      k++;
    }
    if (text[k] !== '>') return null;
    dest = text.slice(j + 1, k);
    j = k + 1;
  } else {
    let k = j;
    let d2 = 0;
    while (k < text.length) {
      const c = text[k];
      if (c === '\\' && k + 1 < text.length && ASCII_PUNCT.has(text[k + 1])) { k += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
      if (c === '(') { d2++; k++; continue; }
      if (c === ')') {
        if (d2 === 0) break;
        d2--; k++; continue;
      }
      k++;
    }
    dest = text.slice(j, k);
    if (!dest) return null;
    j = k;
  }
  let j2 = j;
  let skippedWS = false;
  while (j2 < text.length && (text[j2] === ' ' || text[j2] === '\t')) { j2++; skippedWS = true; }
  let title = null;
  let end;
  const q = text[j2];
  if (q === '"' || q === "'" || q === '(') {
    if (!skippedWS) return null;
    const t = parseTitle(text, j2, q);
    if (!t) return null;
    title = t.title;
    end = t.end;
    let e = end;
    while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
    if (e < text.length && text[e] !== '\n') return null;
    end = e;
  } else if (j2 < text.length && text[j2] === '\n') {
    let k = j2 + 1;
    while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
    const q2 = text[k];
    if (q2 === '"' || q2 === "'" || q2 === '(') {
      const t = parseTitle(text, k, q2);
      let ok = false;
      if (t) {
        let e = t.end;
        while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
        if (e >= text.length || text[e] === '\n') { title = t.title; end = e; ok = true; }
      }
      // A malformed or junk-followed title on the next line is dropped; the
      // definition still stands without a title.
      if (!ok) end = j2;
    } else {
      end = j2;
    }
  } else if (j2 >= text.length) {
    end = j2;
  } else {
    return null;
  }
  return { label, dest, title, end };
}

// ---------------- tables ----------------

function splitRowCells(line) {
  const cells = [];
  let cur = '';
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c === '\\' && line[k + 1] === '|') { cur += '|'; k++; continue; }
    if (c === '|') { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map(c => c.trim());
}

function parseDelimiter(line) {
  const [col] = indentInfo(line);
  if (col > 3) return null;
  const cells = splitRowCells(line);
  if (!cells.length) return null;
  const align = [];
  let hasPipeOrColon = line.indexOf('|') >= 0;
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell[0] === ':';
    const right = cell[cell.length - 1] === ':';
    align.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
    if (left || right) hasPipeOrColon = true;
  }
  return { length: cells.length, align, hasPipeOrColon };
}

function rowEndsTable(line) {
  // Indented code: 4 literal spaces + non-blank content (a tab-only line is
  // a row, not code — marked's table row check uses the code regex, which
  // starts with four spaces).
  if (/^ {4}\S/.test(line)) return true;
  if (isATXStart(line) || isFenceStart(line) || isHRLine(line)) return true;
  const [col, idx] = indentInfo(line);
  if (line[idx] === '>') return true;
  if (listMarker(line)) return true;
  const ht = htmlBlockType(line);
  if (ht >= 1 && ht <= 6) return true;
  return false;
}

// ---------------- paragraph (defs, setext, table) ----------------

Blocks.prototype.consumeDefs = function(lines) {
  if (!lines.length) return lines;
  const text = lines.join('\n');
  let pos = 0;
  let lastEnd = 0;
  while (true) {
    const d = tryParseDef(text, pos);
    if (!d) break;
    const label = normLabel(d.label);
    if (label && !this.defs.has(label)) this.defs.set(label, { href: d.dest, title: d.title });
    lastEnd = d.end;
    pos = d.end;
    if (text[pos] === '\n') pos++;
    else break;
  }
  if (lastEnd === 0) return lines;
  let nl = 0;
  for (let k = 0; k < lastEnd; k++) if (text[k] === '\n') nl++;
  return lines.slice(nl + 1);
};

Blocks.prototype.hasTableDelim = function(lines) {
  for (let k = 1; k < lines.length; k++) {
    const delim = parseDelimiter(lines[k]);
    if (!delim || !delim.hasPipeOrColon) continue;
    if (splitRowCells(lines[k - 1]).length === delim.length) return true;
  }
  return false;
};

Blocks.prototype.tryTable = function(lines) {
  for (let k = 1; k < lines.length; k++) {
    const delim = parseDelimiter(lines[k]);
    if (!delim || !delim.hasPipeOrColon) continue;
    const header = splitRowCells(lines[k - 1]);
    if (header.length !== delim.length) continue;
    const rows = [];
    let r = k + 1;
    while (r < lines.length) {
      const l = lines[r];
      // Marked's table blank check is space-only: a tab-only line is a row.
      if (/^ *$/.test(l) || rowEndsTable(l)) break;
      rows.push(splitRowCells(l));
      r++;
    }
    return {
      before: lines.slice(0, k - 1),
      node: { t: 'table', align: delim.align, head: header, rows },
      consumed: r
    };
  }
  return null;
};

// Sentinel prefixing lazy continuation lines inside containers, so the inner
// parse does not re-read a stripped lazy line as a block start. Stripped when
// paragraph text is assembled.
const LAZY = '';

Blocks.prototype.stripLazy = function(lines) {
  for (let k = 0; k < lines.length; k++) {
    while (lines[k].charCodeAt(0) === 0xE000) lines[k] = lines[k].slice(1);
  }
  return lines;
};

Blocks.prototype.normPara = function(lines) {
  if (!lines.length) return lines;
  lines[0] = stripCols(lines[0], 3);
  const last = lines.length - 1;
  lines[last] = lines[last].replace(/[ \t]+$/, '');
  return lines;
};

Blocks.prototype.tryParagraph = function() {
  const L = this.lines;
  const start = this.i;
  const paraLines = [];
  let j = start;
  while (j < L.length) {
    const l = L[j];
    if (isBlank(l)) {
      // A trailing whitespace-only line at end of input is paragraph text.
      if (j === L.length - 1 && l.length > 0) { paraLines.push(l); j++; }
      // A tab-only line is a table row in marked (its table blank check is
      // space-only), so keep gathering when a table is in progress.
      else if (l.includes('\t') && this.hasTableDelim(paraLines)) { paraLines.push(l); j++; continue; }
      break;
    }
    if (j > start) {
      const se = isSetextLine(l);
      if (se) {
        const text = this.normPara(this.stripLazy(this.consumeDefs(paraLines)));
        if (text.length) {
          this.out.push({ t: 'h', level: se, text: text.join('\n') });
          this.i = j + 1;
        } else {
          this.i = j;
        }
        return;
      }
      if (interruptsPara(l, true, this.inItem)) break;
    }
    paraLines.push(l);
    j++;
  }
  const textLines = this.stripLazy(this.consumeDefs(paraLines));
  if (!textLines.length) { this.i = j; return; }
  const tbl = this.tryTable(textLines);
  if (tbl) {
    if (tbl.before.length) this.out.push({ t: 'p', text: tbl.before.join('\n') });
    this.out.push(tbl.node);
    this.i = start + (paraLines.length - textLines.length) + tbl.consumed;
    return;
  }
  this.out.push({ t: 'p', text: textLines.join('\n') });
  this.i = j;
};

// ---------------- rendering ----------------

function checkboxHtml(checked) {
  return checked ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">';
}

function renderInlineText(text, defs) {
  return inlineParse(text, defs, false, false);
}

function renderListItemTight(it, defs) {
  let out = '';
  let first = true;
  for (const b of it.children) {
    if (b.t === 'p') {
      let inner = renderInlineText(b.text, defs);
      if (first && it.task) inner = checkboxHtml(it.checked) + ' ' + inner;
      out += inner;
    } else {
      out += renderBlocks([b], defs);
    }
    first = false;
  }
  return out;
}

function renderListItemLoose(it, defs) {
  let out = '';
  let first = true;
  for (const b of it.children) {
    if (b.t === 'p') {
      let inner = renderInlineText(b.text, defs);
      if (first && it.task) inner = checkboxHtml(it.checked) + ' ' + inner;
      out += '<p>' + inner + '</p>\n';
    } else {
      out += renderBlocks([b], defs);
    }
    first = false;
  }
  return out;
}

function renderBlocks(blocks, defs) {
  let out = '';
  for (const b of blocks) {
    switch (b.t) {
      case 'p':
        out += '<p>' + renderInlineText(b.text, defs) + '</p>\n';
        break;
      case 'h':
        out += '<h' + b.level + '>' + renderInlineText(b.text, defs) + '</h' + b.level + '>\n';
        break;
      case 'code': {
        const lang = b.lang ? ' class="language-' + escAttr(b.lang) + '"' : '';
        out += '<pre><code' + lang + '>' + esc(b.text) + '</code></pre>\n';
        break;
      }
      case 'hr':
        out += '<hr>\n';
        break;
      case 'q':
        out += '<blockquote>\n' + renderBlocks(b.children, defs) + '</blockquote>\n';
        break;
      case 'html':
        out += b.text;
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const start = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
        out += '<' + tag + start + '>\n';
        for (const it of b.items) {
          out += '<li>';
          if (it.children.length) {
            out += b.loose ? renderListItemLoose(it, defs) : renderListItemTight(it, defs);
          }
          out += '</li>\n';
        }
        out += '</' + tag + '>\n';
        break;
      }
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let c = 0; c < b.head.length; c++) {
          const al = b.align[c] ? ' align="' + b.align[c] + '"' : '';
          out += '<th' + al + '>' + renderInlineText(b.head[c], defs) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (b.rows.length) {
          out += '<tbody>';
          for (const row of b.rows) {
            out += '<tr>\n';
            for (let c = 0; c < b.head.length; c++) {
              const al = b.align[c] ? ' align="' + b.align[c] + '"' : '';
              const cell = c < row.length ? row[c] : '';
              out += '<td' + al + '>' + renderInlineText(cell, defs) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody></table>\n';
        } else {
          out += '</table>\n';
        }
        break;
      }
    }
  }
  return out;
}

// ---------------- entry point ----------------

function parse(src) {
  src = src.replace(/\r\n?/g, '\n');
  let lines = src.split('\n');
  const srcEndsWithNL = src.endsWith('\n');
  if (srcEndsWithNL) lines.pop();
  const defs = new Map();
  const blocks = new Blocks(lines, defs, srcEndsWithNL).parse();
  return renderBlocks(blocks, defs);
}

export { parse };
