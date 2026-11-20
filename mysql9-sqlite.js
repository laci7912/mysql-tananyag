/*!
 * mysql9-sqlite.js — MySQL 9 kompatibilitási réteg sql.js (SQLite) fölé
 * ============================================================================
 * Egyetlen, önálló (nem module) szkript, amely a tananyag HTML-oldalaihoz
 * készült. Kétféleképpen használható, mert mindkét korábbi fájl API-ját adja:
 *
 *   A) mysql-functions-for-sqlite.js stílus (ajánlott):
 *        const mysql = MySQL9;              // vagy MySQLFunctionsForSQLite
 *        const db = mysql.install(new SQL.Database());
 *        const problem = mysql.validate(sql, db);     // null vagy {type, code, message, start, end}
 *        const result  = db.exec(mysql.rewrite(sql)); // MySQL -> SQLite átírás
 *        code.innerHTML = mysql.highlight(sql);       // escape-elt HTML
 *
 *   B) mysql-compat.js stílus (a régi globális függvények):
 *        registerFunctions(db);
 *        db.exec(preprocessSql(sql));
 *        mysqlValidate(sql);
 *        sqlHighlight(sql);
 *
 * RÉTEGEK
 * -------
 *  1. Függvénytár: a MySQL 9 skalár-, szöveg-, dátum-, matematikai, JSON- és
 *     összesítő függvényeit regisztrálja az sql.js motorba, MySQL-szemantikával
 *     (NULL-kezelés, 1-alapú szövegpozíciók, bájt vs. karakter, kerekítés,
 *     GROUP_CONCAT, LIKE magyar ékezetekkel stb.).
 *  2. SQL-átírás: a SQLite által nem ismert MySQL-szintaxist alakítja át
 *     (DIV, MOD, INTERVAL, CAST ... AS SIGNED, TRIM(... FROM ...),
 *     GROUP_CONCAT ... SEPARATOR, INSERT ... SET, ON DUPLICATE KEY UPDATE,
 *     UPDATE/DELETE ... LIMIT, TRUNCATE, SHOW ..., USE, CREATE DATABASE,
 *     ENUM, AUTO_INCREMENT, ENGINE=..., és így tovább).
 *  3. Oktatási ellenőrzés: tipikus kezdőhibák felismerése futtatás előtt,
 *     magyar nyelvű magyarázattal (álnév a WHERE-ben, összesítő a WHERE-ben,
 *     hiányzó GROUP BY, ORDER BY szövegkonstans, SUBSTRING 0, FORMAT csapda).
 *  4. Szintaxiskiemelés: a tananyag .kw/.fn/.str/.num/.ident/.comment osztályai.
 *
 * TÁMOGATÁSI MEGJEGYZÉSEK
 * -----------------------
 *  - A SUM/AVG/MIN/MAX/COUNT/GROUP_CONCAT a SQLite beépített aggregátumai
 *    maradnak (MySQL-kompatibilisek); csak a STDDEV/VARIANCE, BIT_*,
 *    JSON_ARRAYAGG és JSON_OBJECTAGG kerül a rétegből regisztrálásra.
 *  - A több aritású függvények egyetlen, változó argumentumú regisztrációval
 *    kerülnek a motorba, mert a sql.js a függvényt név szerint tárolja
 *    (különben a korábbi aritású hívás csendben NULL-t adna).
 *
 * NEM TÁMOGATOTT (szándékosan, nem tananyag-szintű)
 * ------------------------------------------------
 * felhasználókezelés (CREATE USER, GRANT) — csendben kihagyva, tranzakciós
 * izolációs szintek, tárolt eljárások, triggerek kiváltása, eseményütemező,
 * replikáció, partitions, FULLTEXT/MATCH ... AGAINST, pontos DECIMAL-aritmetika
 * (a JS double ~15 értékes jegy), teljes térinformatika (csak POINT/távolság),
 * numerikus dátum-kontextus (a MySQL `DATE('2024-02-29') + 0` = 20240229-es
 * viselkedése; az SQLite itt a saját típuskonverzióját használja).
 *
 * Verzió: 1.2  ·  MySQL-kompatibilitási szint: 9.0.1-sqlite
 * Nyelv: magyar  ·  Karakterkódolás: UTF-8
 */
(function(root, factory) {
  const library = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = library;
  else {
    root.MySQL9 = library;
    root.MySQLFunctionsForSQLite = library;   // alkototabor_dolgozat.html
    root.registerFunctions = library.registerFunctions;
    root.preprocessSql = library.preprocessSql;
    root.mysqlValidate = library.mysqlValidate;
    root.sqlHighlight = library.sqlHighlight;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';

  /* A VERSION() a MySQL-kompatibilitási szintet adja vissza (ezt várja a
     tananyag és a régi tesztek); a fájl saját kiadása a fejlécben van. */
  const VERSION = '9.0.1-sqlite';
  const HU = 'hu-HU';
  const encoder = new TextEncoder();
  let decoder = null;
  const STRING_LIMIT = 16 * 1024 * 1024;

  /* =======================================================================
   * 1. Alap segédfüggvények: típusok, számok, szöveg
   * ===================================================================== */

  const isNull = v => v === null || v === undefined;

  function decodeBytes(bytes) {
    if (!decoder) decoder = new TextDecoder('utf-8', { fatal: false });
    try { return decoder.decode(bytes); } catch (e) { return String(bytes); }
  }

  /* MySQL szövegkontextus: bájt- és számértékek is szöveggé alakulnak. */
  function asText(v) {
    if (isNull(v)) return null;
    if (v instanceof Uint8Array) return decodeBytes(v);
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
    return String(v);
  }

  function asBytes(v) {
    if (isNull(v)) return null;
    return v instanceof Uint8Array ? v : encoder.encode(String(v));
  }

  function codePoints(v) {
    const s = asText(v);
    return s === null ? null : Array.from(s);
  }

  /* Karakterhossz (kódpont) és bájthossz, ahogy a MySQL számol. */
  const charLength = v => isNull(v) ? null : (v instanceof Uint8Array ? v.length : Array.from(String(v)).length);
  const octetLength = v => isNull(v) ? null : (v instanceof Uint8Array ? v.length : encoder.encode(String(v)).length);

  /* A MySQL laza számkonverziója: a szöveg elejéről olvas, hibánál 0. */
  const NUM_PREFIX = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
  function num(v) {
    if (isNull(v)) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const s = String(v).trim();
    if (!s) return 0;
    const m = NUM_PREFIX.exec(s);
    if (!m) return 0;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : 0;
  }
  const truncInt = v => { const n = num(v); return n === null ? null : Math.trunc(n); };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* Tizedesjegy-eltolás, hogy a kerekítés ne szenvedjen a bináris pontatlanságtól. */
  function shiftExp(x, e) {
    const r = Number(x.toPrecision(15) + 'e' + e);
    return Number.isFinite(r) ? r : x;
  }

  /* MySQL ROUND: féltől ELFELÉ kerekít, negatív pontosság is (pl. -1). */
  function roundTo(value, places) {
    const x = num(value);
    if (x === null) return null;
    if (!Number.isFinite(x)) return x;
    const p = clamp(places === undefined || places === null ? 0 : truncInt(places), -30, 30);
    if (x === 0) return 0;
    const negative = x < 0, abs = Math.abs(x);
    const shifted = shiftExp(abs, p);
    const rounded = Math.floor(shifted + 0.5);
    const back = shiftExp(rounded, -p);
    return negative ? -back : back;
  }

  /* MySQL TRUNCATE: kerekítés nélküli levágás, negatív pontossággal is. */
  function truncateTo(value, places) {
    const x = num(value);
    if (x === null) return null;
    if (!Number.isFinite(x)) return x;
    const p = clamp(places === undefined || places === null ? 0 : truncInt(places), -30, 30);
    if (x === 0) return 0;
    const negative = x < 0, abs = Math.abs(x);
    const truncated = Math.trunc(shiftExp(abs, p));
    const back = shiftExp(truncated, -p);
    return negative ? -back : back;
  }

  /* MySQL osztás: a / valódi (tizedes) osztás, nullával osztva NULL. */
  function realDivide(a, b) {
    const x = num(a), y = num(b);
    if (x === null || y === null) return null;
    if (y === 0) return null;
    return x / y;
  }
  /* DIV: egész hányados, a nulla felé csonkolva; nullával osztva NULL. */
  function integerDivide(a, b) {
    const x = num(a), y = num(b);
    if (x === null || y === null) return null;
    if (y === 0) return null;
    return Math.trunc(x / y);
  }
  /* MOD / %: az osztandó előjelét követi, nullával osztva NULL. */
  function modulo(a, b) {
    const x = num(a), y = num(b);
    if (x === null || y === null) return null;
    if (y === 0) return null;
    return x % y;
  }

  /* Unicode-korrekt, kis-nagybetűt nem érzékelő LIKE, NFC-normalizálással. */
  function likeMatch(pattern, value, escapeChar) {
    if (isNull(pattern) || isNull(value)) return null;
    const esc = isNull(escapeChar) ? '\\' : String(escapeChar);
    if (Array.from(esc).length > 1) throw new Error('Az ESCAPE legfeljebb egy karakter lehet.');
    const input = Array.from(String(value).normalize('NFC').toLocaleLowerCase(HU));
    const parts = Array.from(String(pattern).normalize('NFC').toLocaleLowerCase(HU));
    const tokens = [];
    for (let i = 0; i < parts.length; i++) {
      const ch = parts[i];
      if (ch === esc && i + 1 < parts.length) tokens.push({ char: parts[++i] });
      else if (ch === '%') tokens.push({ many: true });
      else if (ch === '_') tokens.push({ one: true });
      else tokens.push({ char: ch });
    }
    let i = 0, j = 0, wildcard = -1, matched = 0;
    while (i < input.length) {
      const part = tokens[j];
      if (part && part.many) { wildcard = j++; matched = i; }
      else if (part && (part.one || part.char === input[i])) { i++; j++; }
      else if (wildcard >= 0) { j = wildcard + 1; i = ++matched; }
      else return 0;
    }
    while (tokens[j] && tokens[j].many) j++;
    return j === tokens.length ? 1 : 0;
  }

  /* MySQL REGEXP / RLIKE (ICU-szerű, magyar ékezetre is). */
  function regexpSource(pattern, flags) {
    let source = String(pattern);
    let options = isNull(flags) ? '' : String(flags);
    const m = /^\(\?([a-z]*)\)/i.exec(source);
    if (m) { options += m[1]; source = source.slice(m[0].length); }
    /* A MySQL regex alapból kis-nagybetűt nem érzékel (utf8mb4_0900_ai_ci). */
    if (!/i/.test(options)) options += 'i';
    if (/c/.test(options)) options = options.replace(/c/g, '').replace(/i/g, '');
    return { source, options: options.replace(/[^imsu]/g, '') };
  }

  function regexpLike(value, pattern, flags) {
    if (isNull(value) || isNull(pattern)) return null;
    const rx = regexpSource(pattern, flags);
    try {
      return new RegExp(rx.source, rx.options).test(String(value)) ? 1 : 0;
    } catch (e) {
      throw new Error('Érvénytelen reguláris kifejezés: ' + rx.source);
    }
  }

  /* REGEXP_REPLACE(kifejezés, minta, csere [, pozíció [, előfordulás [, jelzők]]]) */
  function regexpReplace(value, pattern, replacement, position, occurrence, flags) {
    if (isNull(value) || isNull(pattern) || isNull(replacement)) return null;
    const rx = regexpSource(pattern, flags);
    let re;
    try { re = new RegExp(rx.source, rx.options + 'g'); }
    catch (e) { throw new Error('Érvénytelen reguláris kifejezés: ' + rx.source); }
    const text = String(value);
    const pos = isNull(position) ? 1 : Math.max(1, truncInt(position));
    const occ = isNull(occurrence) ? 0 : truncInt(occurrence);
    const head = Array.from(text).slice(0, pos - 1).join('');
    const body = Array.from(text).slice(pos - 1).join('');
    const replaced = body.replace(re, function () {
      const args = Array.prototype.slice.call(arguments);
      const match = args[0];
      /* A csere-stringben a MySQL a $1..$9 / \1 hivatkozásokat ismeri. */
      const groups = args.slice(1, -2);
      return String(replacement).replace(/\$(\d+)|\\(\d+)/g, (m2, a, b) => {
        const idx = Number(a || b);
        return idx === 0 ? match : (groups[idx - 1] === undefined ? '' : groups[idx - 1]);
      });
    });
    return head + replaced;
  }

  function regexpSubstr(value, pattern, position, occurrence, flags) {
    if (isNull(value) || isNull(pattern)) return null;
    const rx = regexpSource(pattern, flags);
    const text = String(value);
    const pos = isNull(position) ? 1 : Math.max(1, truncInt(position));
    const body = Array.from(text).slice(pos - 1).join('');
    let re;
    try { re = new RegExp(rx.source, rx.options + 'g'); }
    catch (e) { throw new Error('Érvénytelen reguláris kifejezés: ' + rx.source); }
    const matches = [];
    let m;
    while ((m = re.exec(body)) !== null) {
      matches.push(m[0]);
      if (!m[0].length) re.lastIndex++;
    }
    const occ = isNull(occurrence) ? 1 : Math.max(1, truncInt(occurrence));
    return matches.length >= occ ? matches[occ - 1] : null;
  }

  function regexpInstr(value, pattern, position, occurrence, returnOption, flags) {
    if (isNull(value) || isNull(pattern)) return null;
    const rx = regexpSource(pattern, flags);
    const text = String(value);
    const pos = isNull(position) ? 1 : Math.max(1, truncInt(position));
    const body = Array.from(text).slice(pos - 1).join('');
    let re;
    try { re = new RegExp(rx.source, rx.options + 'g'); }
    catch (e) { throw new Error('Érvénytelen reguláris kifejezés: ' + rx.source); }
    const occ = isNull(occurrence) ? 1 : Math.max(1, truncInt(occurrence));
    const returnEnd = !isNull(returnOption) && truncInt(returnOption) === 1;
    let count = 0, m;
    while ((m = re.exec(body)) !== null) {
      count++;
      if (count === occ) {
        const offset = Array.from(body.slice(0, m.index)).length;
        return returnEnd ? pos + offset + Array.from(m[0]).length : pos + offset;
      }
      if (!m[0].length) re.lastIndex++;
    }
    return 0;
  }

  /* MySQL FORMAT: ezres tagolás, rögzített tizedesjegy, locale szerint. */  function formatNumber(value, places, locale) {
    const x = num(value);
    if (x === null || isNull(places)) return null;
    const digits = clamp(truncInt(places), 0, 30);
    const options = { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: true };
    let loc = String(isNull(locale) ? 'en_US' : locale).replace('_', '-');
    let out;
    try { out = new Intl.NumberFormat(loc, options).format(x); }
    catch (e) { out = new Intl.NumberFormat('en-US', options).format(x); }
    return out.replace(/[\u00A0\u202F]/g, ' ');
  }

  function repeatText(value, count) {
    const s = asText(value);
    if (s === null || isNull(count)) return null;
    const n = Math.max(0, truncInt(count));
    if (!s || !n) return '';
    if (s.length * n > STRING_LIMIT) throw new RangeError('A létrehozott szöveg túl hosszú.');
    return s.repeat(n);
  }

  function padText(value, length, filler, left) {
    const s = codePoints(value);
    if (s === null || isNull(length) || isNull(filler)) return null;
    const size = truncInt(length);
    if (!(size > 0)) return '';
    if (s.length >= size) return s.slice(0, size).join('');
    const pattern = codePoints(filler);
    if (!pattern.length) return null;
    const extra = size - s.length;
    const fill = repeatText(filler, Math.floor(extra / pattern.length)) + pattern.slice(0, extra % pattern.length).join('');
    return left ? fill + s.join('') : s.join('') + fill;
  }

  /* MySQL SUBSTRING: 1-alapú, negatív pozíció a végétől, 0 => ''. */
  function substringOf(value, position, length) {
    const chars = codePoints(value);
    if (chars === null || isNull(position)) return null;
    if (length !== undefined && isNull(length)) return null;
    const start = truncInt(position);
    if (start === 0) return '';
    const offset = start > 0 ? start - 1 : chars.length + start;
    if (offset < 0 || offset >= chars.length) return '';
    if (length === undefined) return chars.slice(offset).join('');
    const count = truncInt(length);
    if (!(count > 0)) return '';
    return chars.slice(offset, offset + count).join('');
  }

  /* SUBSTRING_INDEX(str, delim, count) */
  function substringIndex(value, delimiter, count) {
    const s = asText(value), d = asText(delimiter);
    if (s === null || d === null || isNull(count)) return null;
    const pieces = s.split(d);
    const n = truncInt(count);
    if (!n || !d) return '';
    return (n > 0 ? pieces.slice(0, n) : pieces.slice(n)).join(d);
  }

  /* TRIM([LEADING|TRAILING|BOTH] x FROM y) */
  function trimDirection(value, removable, mode) {
    let s = asText(value);
    const part = asText(removable);
    if (s === null || part === null) return null;
    if (!part) return s;
    const side = String(mode || 'BOTH').toUpperCase();
    if (side === 'LEADING' || side === 'BOTH') while (s.startsWith(part)) s = s.slice(part.length);
    if (side === 'TRAILING' || side === 'BOTH') while (s.endsWith(part)) s = s.slice(0, s.length - part.length);
    return s;
  }

  function findInSet(needle, list) {
    const s = asText(needle), l = asText(list);
    if (s === null || l === null) return null;
    if (!l) return 0;
    return l.split(',').indexOf(s) + 1;
  }

  function fieldOf(needle, ...rest) {
    const s = asText(needle);
    if (s === null) return 0;
    for (let i = 0; i < rest.length; i++) {
      const v = asText(rest[i]);
      if (v !== null && (v === s || num(v) === num(s) && NUM_PREFIX.test(s) && NUM_PREFIX.test(v))) return i + 1;
    }
    return 0;
  }

  function elt(index, ...rest) {
    const n = truncInt(index);
    if (!(n >= 1) || n > rest.length) return null;
    return asText(rest[n - 1]);
  }

  function makeSet(bits, ...rest) {
    const n = truncInt(bits);
    if (n === null) return null;
    const out = [];
    for (let i = 0; i < rest.length; i++) if (n & (1 << i)) out.push(asText(rest[i]));
    return out.join(',');
  }

  function insertString(value, position, length, replacement) {
    const chars = codePoints(value), insert = codePoints(replacement);
    if (chars === null || isNull(position) || isNull(length) || insert === null) return null;
    const start = truncInt(position);
    const count = truncInt(length);
    if (start < 1 || start > chars.length) return chars.join('');
    const end = count < 0 ? chars.length : start - 1 + count;
    return chars.slice(0, start - 1).join('') + insert.join('') + chars.slice(end).join('');
  }

  function strcmp(a, b) {
    const x = asText(a), y = asText(b);
    if (x === null || y === null) return null;
    const left = Array.from(x), right = Array.from(y);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const lc = left[i].codePointAt(0), rc = right[i].codePointAt(0);
      if (lc !== rc) return lc < rc ? -1 : 1;
    }
    return left.length === right.length ? 0 : (left.length < right.length ? -1 : 1);
  }

  function hexOf(value) {
    /* A MySQL a számot egészként hexadecimálisra váltja (HEX(255) = 'FF'),
       a szöveget viszont bájtonként. */
    if (typeof value === 'number') {
      const n = Math.trunc(value);
      return (n < 0 ? (n >>> 0) : n).toString(16).toUpperCase();
    }
    const bytes = asBytes(value);
    if (bytes === null) return null;
    let out = '';
    for (const b of bytes) out += b.toString(16).toUpperCase().padStart(2, '0');
    return out;
  }

  function unhexOf(value) {
    const s = asText(value);
    if (s === null) return null;
    if (!s.length) return '';
    if (!/^[0-9a-fA-F]*$/.test(s)) return null;
    /* A MySQL a páratlan hosszt is elfogadja: a végén 0-val egészíti ki. */
    const hex = s.length % 2 ? s + '0' : s;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    /* A tananyag szövegkontextusban használja, ezért UTF-8 szöveget adunk. */
    return decodeBytes(out);
  }

  function base64Encode(value) {
    const bytes = asBytes(value);
    if (bytes === null) return null;
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  function base64Decode(value) {
    const s = asText(value);
    if (s === null) return null;
    try {
      const bin = atob(s.replace(/\s+/g, ''));
      let text = '';
      try { text = decodeURIComponent(Array.from(bin, c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')); }
      catch (e) { text = null; }
      if (text !== null) return text;
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) { return null; }
  }

  function bitCount(value) {
    let n = truncInt(value);
    if (n === null) return null;
    n = n >>> 0;
    let count = 0;
    while (n) { count += n & 1; n >>>= 1; }
    return count;
  }

  function convertBase(value, fromBase, toBase) {
    const s = asText(value), f = truncInt(fromBase), t = truncInt(toBase);
    if (s === null || !(f >= 2 && f <= 36) || !(t >= 2 && t <= 36)) return null;
    const negative = s.trim().startsWith('-');
    let n = parseInt(s.trim().replace(/^-/, ''), f);
    if (!Number.isFinite(n)) return null;
    let out = Math.abs(n).toString(t).toUpperCase();
    return (negative && n !== 0 ? '-' : '') + out;
  }

  let CRC_TABLE = null;
  function crc32(value) {
    const bytes = asBytes(value);
    if (bytes === null) return null;
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[i] = c >>> 0;
      }
    }
    let crc = 0xFFFFFFFF;
    for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /* Feldolgozás alatt álló kötegek állapota (adatbázis, aktuális séma, változók). */
  function makeState(db) {
    return {
      db: db || null,
      schema: 'main',
      vars: new Map(),
      warnings: [],
      options: { pipesAsConcat: false, likeUnicode: true, foreignKeys: false }
    };
  }
  let defaultState = makeState(null);

  /* =======================================================================
   * 2. Dátum- és időfüggvények
   * ---------------------------------------------------------------------
   * Belül minden dátum/idő "YYYY-MM-DD HH:MM:SS[.ffffff]" alakú, UTC-alapú
   * számítással. A MySQL session időzóna helyett a böngésző helyi idejét
   * használjuk a NOW()/CURDATE() esetén, a többi függvény időzóna-független.
   * ===================================================================== */

  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const MS_DAY = 86400000;

  const DATE_RE = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,6}))?)?)?$/;
  const COMPACT_DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
  const COMPACT_DATETIME_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;
  const TIME_RE = /^(-)?(\d{1,3}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,6}))?)?$/;
  const YEAR_RE = /^(\d{4})$/;

  function pad2(n) { return String(n).padStart(2, '0'); }
  function pad6(us) { return String(us || 0).padStart(6, '0'); }

  function validParts(y, m, d, h, mi, s) {
    if (!(y >= 1000 && y <= 9999)) return false;
    if (!(m >= 1 && m <= 12)) return false;
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    if (!(d >= 1 && d <= dim)) return false;
    if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59) || !(s >= 0 && s <= 59)) return false;
    return true;
  }

  /* Egy értékből dátum/idő részeket olvas. Visszaad: struct vagy null. */
  function parseDateTime(value, allowTime) {
    if (isNull(value)) return null;
    if (typeof value === 'number') {
      const n = value;
      if (Number.isInteger(n) && n >= 10000101 && n <= 99991231) value = String(n);
      else if (Number.isInteger(n) && n >= 1000 && n <= 9999) value = String(n) + '-01-01';
      else return null;
    }
    const s = String(value).trim();
    if (!s || /^0000-00-00/.test(s)) return null;
    let m;
    if ((m = COMPACT_DATETIME_RE.exec(s))) return buildParts(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], 0, false);
    if ((m = COMPACT_DATE_RE.exec(s))) return buildParts(+m[1], +m[2], +m[3], 0, 0, 0, 0, true);
    if ((m = DATE_RE.exec(s))) return buildParts(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), m[7] ? +(m[7] + '000000').slice(0, 6) : 0, m[4] === undefined);
    if ((m = YEAR_RE.exec(s))) return buildParts(+m[1], 1, 1, 0, 0, 0, 0, true);
    if (allowTime !== false && (m = TIME_RE.exec(s))) {
      const negative = !!m[1];
      const h = +m[2], mi = +m[3], sec = +(m[4] || 0);
      const us = m[5] ? +(m[5] + '000000').slice(0, 6) : 0;
      if (mi > 59 || sec > 59) return null;
      return { timeOnly: true, negative, h, mi, s: sec, us, y: 0, m: 0, d: 0, dateOnly: false };
    }
    return null;
  }

  function buildParts(y, m, d, h, mi, s, us, dateOnly) {
    if (!validParts(y, m, d, h, mi, s)) return null;
    return { y, m, d, h, mi, s, us: us || 0, dateOnly, timeOnly: false, negative: false };
  }

  function partsToMs(p) {
    if (!p || p.timeOnly) return null;
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s, Math.floor(p.us / 1000)) + p.us % 1000 / 1000;
  }

  function msToParts(ms, dateOnly) {
    const dt = new Date(ms);
    return {
      y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(),
      h: dt.getUTCHours(), mi: dt.getUTCMinutes(), s: dt.getUTCSeconds(),
      us: dt.getUTCMilliseconds() * 1000, dateOnly: !!dateOnly, timeOnly: false, negative: false
    };
  }

  function formatDateParts(p, withTime) {
    if (!p) return null;
    if (p.timeOnly) {
      const sign = p.negative ? '-' : '';
      return sign + pad2(p.h) + ':' + pad2(p.mi) + ':' + pad2(p.s);
    }
    const date = p.y + '-' + pad2(p.m) + '-' + pad2(p.d);
    if (!withTime || p.dateOnly) return date;
    return date + ' ' + pad2(p.h) + ':' + pad2(p.mi) + ':' + pad2(p.s);
  }

  function timePartsToSeconds(p) {
    const total = p.h * 3600 + p.mi * 60 + p.s;
    return (p.negative ? -total : total) + p.us / 1e6;
  }

  function secondsToTimeParts(total) {
    const negative = total < 0;
    let rest = Math.abs(total);
    const h = Math.floor(rest / 3600); rest -= h * 3600;
    const mi = Math.floor(rest / 60); rest -= mi * 60;
    const s = Math.floor(rest);
    const us = Math.round((rest - s) * 1e6);
    return { timeOnly: true, negative, h, mi, s, us, y: 0, m: 0, d: 0, dateOnly: false };
  }

  /* Dátum/idő argumentum normalizálása; idő-only érték esetén null. */
  function dateArg(v) { return parseDateTime(v, false); }

  function mysqlDate(v) {
    const p = dateArg(v);
    return p ? formatDateParts(p, false) : null;
  }
  function mysqlTime(v) {
    const p = parseDateTime(v, true);
    return p ? (p.timeOnly ? formatDateParts(p, false) : pad2(p.h) + ':' + pad2(p.mi) + ':' + pad2(p.s)) : null;
  }
  function fieldOfDate(v, getter) {
    const p = dateArg(v);
    return p ? getter(p) : null;
  }

  function dayOfYear(p) {
    return Math.floor((Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(p.y, 0, 1)) / MS_DAY) + 1;
  }

  /* Napok száma a korszak kezdetétől (1970-01-01 = 0). 1970-01-01 csütörtök. */
  function dayNumber(y, m, d) {
    return Math.floor(Date.UTC(y, m - 1, d) / MS_DAY);
  }

  /* A hét első napja (0 = vasárnap, 1 = hétfő) szerinti hét-kezdő nap
     sorszáma arra a hétre, amelybe az adott nap esik. */
  function weekStartNumber(dn, firstDay) {
    const dowRel = ((dn + 4) % 7 - firstDay + 7) % 7;
    return dn - dowRel;
  }

  /* Az adott év 1. hetének kezdő napja a MySQL WEEK() szabályai szerint.
     A 8 mód a MySQL dokumentált táblázata szerint:
       0 = vasárnap, 0-53, az év első vasárnapja nyitja az 1. hetet
       1 = hétfő,   0-53, 4+ napos hét az 1. hét
       2 = vasárnap, 1-53, az év első vasárnapja nyitja az 1. hetet
       3 = hétfő,   1-53, 4+ napos hét az 1. hét (ISO)
       4 = vasárnap, 0-53, 4+ napos hét az 1. hét
       5 = hétfő,   0-53, az év első hétfője nyitja az 1. hetet
       6 = vasárnap, 1-53, 4+ napos hét az 1. hét
       7 = hétfő,   1-53, az év első hétfője nyitja az 1. hetet */
  const weekMondayFirst = m => m === 1 || m === 3 || m === 5 || m === 7;
  const weekOneBased = m => m === 2 || m === 3 || m === 6 || m === 7;
  const weekFourDayRule = m => m === 1 || m === 3 || m === 4 || m === 6;

  function week1Start(y, mode) {
    const firstDay = weekMondayFirst(mode) ? 1 : 0;
    const jan1 = dayNumber(y, 1, 1);
    const jan1Rel = ((jan1 + 4) % 7 - firstDay + 7) % 7;
    if (weekFourDayRule(mode)) {
      /* Az a hét az 1. hét, amelyből legalább 4 nap az új évben van. */
      return (7 - jan1Rel) >= 4 ? jan1 - jan1Rel : jan1 - jan1Rel + 7;
    }
    /* Az év első hétkezdő napja (vasárnap vagy hétfő) nyitja az 1. hetet. */
    return jan1Rel === 0 ? jan1 : jan1 - jan1Rel + 7;
  }

  function normalizeWeekMode(mode) {
    if (mode === undefined || mode === null) return 0;
    const m = truncInt(mode);
    return m === null ? 0 : clamp(m, 0, 7);
  }

  function weekOf(p, mode) {
    /* MySQL WEEK(): a hét száma a megadott üzemmód szerint. */
    const m = normalizeWeekMode(mode);
    const firstDay = weekMondayFirst(m) ? 1 : 0;
    const dn = dayNumber(p.y, p.m, p.d);
    const ws = weekStartNumber(dn, firstDay);
    const w1 = week1Start(p.y, m);
    if (ws < w1) {
      /* A hét az előző évhez tartozik. 1-alapú módoknál az előző év
         utolsó hetének számát adjuk, különben 0-t. */
      if (!weekOneBased(m)) return 0;
      return Math.floor((ws - week1Start(p.y - 1, m)) / 7) + 1;
    }
    if (weekOneBased(m) && ws >= week1Start(p.y + 1, m)) return 1;
    return Math.floor((ws - w1) / 7) + 1;
  }

  function weekYearOf(p, mode) {
    /* YEARWEEK() éve: melyik évhez tartozik a hét (átcsúszhat évhatáron). */
    const m = normalizeWeekMode(mode);
    const firstDay = weekMondayFirst(m) ? 1 : 0;
    const dn = dayNumber(p.y, p.m, p.d);
    const ws = weekStartNumber(dn, firstDay);
    if (ws < week1Start(p.y, m)) return p.y - 1;
    if (weekOneBased(m) && ws >= week1Start(p.y + 1, m)) return p.y + 1;
    return p.y;
  }

  /* YEARWEEK(): YYYYWW, ahol a hét sorszáma a hét évéhez viszonyított,
     1-alapú érték (ezért lesz YEARWEEK('2000-01-01') = 199952, miközben
     WEEK('2000-01-01', 0) = 0). */
  function yearWeekOf(p, mode) {
    const m = normalizeWeekMode(mode);
    const firstDay = weekMondayFirst(m) ? 1 : 0;
    const dn = dayNumber(p.y, p.m, p.d);
    const ws = weekStartNumber(dn, firstDay);
    const wy = weekYearOf(p, m);
    return wy * 100 + Math.floor((ws - week1Start(wy, m)) / 7) + 1;
  }

  function lastDayOf(v) {
    const p = dateArg(v);
    if (!p) return null;
    const dim = new Date(Date.UTC(p.y, p.m, 0)).getUTCDate();
    return p.y + '-' + pad2(p.m) + '-' + pad2(dim);
  }

  function addInterval(p, unit, amount) {
    const u = String(unit).toUpperCase().replace(/S$/, '');
    const n = truncInt(amount);
    if (n === null) return null;
    const base = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);

    /* Hónap/negyedév/év: MySQL ledobja a napot a célhónap végére. */
    if (u === 'MONTH' || u === 'QUARTER' || u === 'YEAR') {
      const monthShift = u === 'YEAR' ? n * 12 : (u === 'QUARTER' ? n * 3 : n);
      const total = (p.y * 12 + p.m - 1) + monthShift;
      const year = Math.floor(total / 12);
      const month = total - year * 12;
      const day = Math.min(p.d, new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
      const dt = new Date(Date.UTC(year, month, day, p.h, p.mi, p.s, Math.floor(p.us / 1000)));
      return msToParts(dt.getTime(), p.dateOnly);
    }
    const dt = new Date(base);
    switch (u) {
      case 'WEEK': dt.setUTCDate(dt.getUTCDate() + n * 7); break;
      case 'DAY': dt.setUTCDate(dt.getUTCDate() + n); break;
      case 'HOUR': dt.setUTCHours(dt.getUTCHours() + n); break;
      case 'MINUTE': dt.setUTCMinutes(dt.getUTCMinutes() + n); break;
      case 'SECOND': dt.setUTCSeconds(dt.getUTCSeconds() + n); break;
      case 'MICROSECOND': return msToParts(base + n / 1000, p.dateOnly);
      default: return null;
    }
    return msToParts(dt.getTime(), p.dateOnly);
  }

  function dateAdd(v, unit, amount) {
    const p = dateArg(v);
    if (!p) return null;
    const out = addInterval(p, unit, amount);
    return out ? formatDateParts(out, true) : null;
  }
  function dateSub(v, unit, amount) {
    const p = dateArg(v);
    if (!p) return null;
    const out = addInterval(p, unit, isNull(amount) ? null : -truncInt(amount));
    return out ? formatDateParts(out, true) : null;
  }

  function datediff(a, b) {
    const pa = dateArg(a), pb = dateArg(b);
    if (!pa || !pb) return null;
    return Math.round((Date.UTC(pa.y, pa.m - 1, pa.d) - Date.UTC(pb.y, pb.m - 1, pb.d)) / MS_DAY);
  }

  function timestampdiff(unit, a, b) {
    const pa = parseDateTime(a, true), pb = parseDateTime(b, true);
    if (!pa || !pb) return null;
    const u = String(unit).toUpperCase().replace(/S$/, '');
    if (pa.timeOnly && pb.timeOnly) {
      const diff = timePartsToSeconds(pb) - timePartsToSeconds(pa);
      return Math.trunc(diff / unitSeconds(u));
    }
    const da = Date.UTC(pa.y, pa.m - 1, pa.d, pa.h, pa.mi, pa.s);
    const db = Date.UTC(pb.y, pb.m - 1, pb.d, pb.h, pb.mi, pb.s);
    if (u === 'MONTH' || u === 'QUARTER' || u === 'YEAR') {
      const months = (pb.y - pa.y) * 12 + (pb.m - pa.m);
      const dayPart = (pb.d - pa.d) / 32;
      const raw = months + dayPart;
      if (u === 'MONTH') return Math.trunc(raw);
      if (u === 'QUARTER') return Math.trunc(raw / 3);
      return Math.trunc(raw / 12);
    }
    return Math.trunc((db - da) / (unitSeconds(u) * 1000));
  }
  function unitSeconds(u) {
    switch (u) {
      case 'MICROSECOND': return 1e-6;
      case 'SECOND': return 1;
      case 'MINUTE': return 60;
      case 'HOUR': return 3600;
      case 'DAY': return 86400;
      case 'WEEK': return 604800;
      default: return 1;
    }
  }
  function timestampadd(unit, amount, v) {
    const n = truncInt(amount);
    if (n === null) return null;
    const p = parseDateTime(v, true);
    if (!p) return null;
    const u = String(unit).toUpperCase().replace(/S$/, '');
    if (p.timeOnly) {
      const total = timePartsToSeconds(p) + n * unitSeconds(u) * (u === 'MICROSECOND' ? 1e-6 : 1);
      return formatDateParts(secondsToTimeParts(total), false);
    }
    const out = addInterval(p, u === 'MICROSECOND' ? 'MICROSECOND' : u, n);
    return out ? formatDateParts(out, true) : null;
  }

  function timediff(a, b) {
    const pa = parseDateTime(a, true), pb = parseDateTime(b, true);
    if (!pa || !pb) return null;
    const ta = pa.timeOnly ? timePartsToSeconds(pa) : (pa.h * 3600 + pa.mi * 60 + pa.s);
    const tb = pb.timeOnly ? timePartsToSeconds(pb) : (pb.h * 3600 + pb.mi * 60 + pb.s);
    return formatDateParts(secondsToTimeParts(ta - tb), false);
  }
  function addtime(a, b) {
    const pa = parseDateTime(a, true), pb = parseDateTime(b, true);
    if (!pa || !pb) return null;
    if (pa.timeOnly && pb.timeOnly) {
      return formatDateParts(secondsToTimeParts(timePartsToSeconds(pa) + timePartsToSeconds(pb)), false);
    }
    const base = partsToMs(pa);
    const delta = pb.timeOnly ? timePartsToSeconds(pb) : partsToMs(pb) - Date.UTC(1970, 0, 1);
    return formatDateParts(msToParts(base + delta * 1000, pa.dateOnly), true);
  }
  function subtime(a, b) {
    const pa = parseDateTime(a, true), pb = parseDateTime(b, true);
    if (!pa || !pb) return null;
    if (pa.timeOnly && pb.timeOnly) {
      return formatDateParts(secondsToTimeParts(timePartsToSeconds(pa) - timePartsToSeconds(pb)), false);
    }
    const base = partsToMs(pa);
    const delta = pb.timeOnly ? timePartsToSeconds(pb) : partsToMs(pb) - Date.UTC(1970, 0, 1);
    return formatDateParts(msToParts(base - delta * 1000, pa.dateOnly), true);
  }

  function secToTime(seconds) {
    const n = num(seconds);
    if (n === null) return null;
    return formatDateParts(secondsToTimeParts(n), false);
  }
  function timeToSec(v) {
    const p = parseDateTime(v, true);
    if (!p) return null;
    return Math.trunc(timePartsToSeconds(p));
  }

  function toDays(v) {
    const p = dateArg(v);
    if (!p) return null;
    return Math.floor(Date.UTC(p.y, p.m - 1, p.d) / MS_DAY) + 719528;
  }
  function fromDays(days) {
    const n = truncInt(days);
    if (n === null || n < 366) return null;
    return formatDateParts(msToParts((n - 719528) * MS_DAY, true), false);
  }
  function toSeconds(v) {
    const p = parseDateTime(v, true);
    if (!p) return null;
    if (p.timeOnly) return Math.trunc(timePartsToSeconds(p));
    return toDays(v) * 86400 + p.h * 3600 + p.mi * 60 + p.s;
  }

  function unixTimestamp(v) {
    if (v === undefined) return Math.floor(Date.now() / 1000);
    const p = parseDateTime(v, true);
    if (!p) return null;
    if (p.timeOnly) return Math.trunc(timePartsToSeconds(p));
    return Math.floor(partsToMs(p) / 1000);
  }
  function fromUnixtime(value, format) {
    const n = num(value);
    if (n === null) return null;
    if (isNull(format)) return formatDateParts(msToParts(n * 1000, false), true);
    return dateFormat(fromUnixtime(value), format);
  }

  function makeDate(year, dayOfYearValue) {
    const y = truncInt(year), d = truncInt(dayOfYearValue);
    if (y === null || d === null || d < 1) return null;
    const ms = Date.UTC(y, 0, 1) + (d - 1) * MS_DAY;
    const out = msToParts(ms, true);
    return out.y === y ? formatDateParts(out, false) : null;
  }
  function makeTime(hour, minute, second) {
    const h = truncInt(hour), mi = truncInt(minute);
    let s = num(second);
    if (h === null || mi === null || s === null) return null;
    if (mi < 0 || mi > 59) return null;
    return formatDateParts(secondsToTimeParts(h * 3600 + mi * 60 + s), false);
  }
  function periodAdd(period, months) {
    const p = truncInt(period), n = truncInt(months);
    if (p === null || n === null) return null;
    const y = Math.floor(p / 100), m = p % 100 - 1 + n;
    const year = y + Math.floor(m / 12);
    const month = ((m % 12) + 12) % 12 + 1;
    return year * 100 + month;
  }
  function periodDiff(a, b) {
    const x = truncInt(a), y = truncInt(b);
    if (x === null || y === null) return null;
    return (Math.floor(x / 100) * 12 + x % 100) - (Math.floor(y / 100) * 12 + y % 100);
  }

  function getFormat(kind, locale) {    const k = String(kind || '').toUpperCase();
    const loc = String(locale || 'en_US').toUpperCase().replace('-', '_');
    if (k === 'DATE') return loc === 'USA' ? '%m.%d.%Y' : (loc === 'JIS' || loc === 'ISO' ? '%Y-%m-%d' : '%Y-%m-%d');
    if (k === 'TIME') return loc === 'USA' ? '%h:%i:%s %p' : '%H:%i:%s';
    if (k === 'DATETIME') return loc === 'USA' ? '%Y-%m-%d %h:%i:%s %p' : '%Y-%m-%d %H:%i:%s';
    return null;
  }

  function weekdayIndex(p) { return (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7; }

  /* EXTRACT(egység FROM dátum) – a MySQL egységeivel. */
  function extractPart(unit, value) {
    const u = String(unit).toUpperCase();
    const p = parseDateTime(value, true);
    if (!p) return null;
    switch (u) {
      case 'YEAR': return p.y;
      case 'QUARTER': return Math.floor((p.m - 1) / 3) + 1;
      case 'MONTH': return p.m;
      case 'WEEK': return weekOf(p, 0);
      case 'DAY': return p.d;
      case 'HOUR': return p.h;
      case 'MINUTE': return p.mi;
      case 'SECOND': return p.s;
      case 'MICROSECOND': return p.us;
      case 'YEAR_MONTH': return p.y * 100 + p.m;
      case 'DAY_HOUR': return p.d * 100 + p.h;
      case 'DAY_MINUTE': return p.d * 10000 + p.h * 100 + p.mi;
      case 'DAY_SECOND': return p.d * 1000000 + p.h * 10000 + p.mi * 100 + p.s;
      case 'HOUR_MINUTE': return p.h * 100 + p.mi;
      case 'HOUR_SECOND': return p.h * 10000 + p.mi * 100 + p.s;
      case 'MINUTE_SECOND': return p.mi * 100 + p.s;
      case 'DAYOFWEEK': return (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 1);
      case 'DAYOFYEAR': return dayOfYear(p);
      default: return null;
    }
  }

  function dateFormat(value, format) {
    const p = parseDateTime(value, true);
    if (!p || isNull(format)) return null;
    const fmt = String(format);
    const out = [];
    for (let i = 0; i < fmt.length; i++) {
      const ch = fmt[i];
      if (ch !== '%') { out.push(ch); continue; }
      const spec = fmt[++i] || '';
      switch (spec) {
        case 'a': out.push(DAY_NAMES[weekdayIndex(p)].slice(0, 3)); break;
        case 'b': out.push(MONTH_NAMES[p.m - 1].slice(0, 3)); break;
        case 'c': out.push(String(p.m)); break;
        case 'D': out.push(ordinal(p.d)); break;
        case 'd': out.push(pad2(p.d)); break;
        case 'e': out.push(String(p.d)); break;
        case 'f': out.push(pad6(p.us)); break;
        case 'H': out.push(pad2(p.h)); break;
        case 'h': case 'I': out.push(pad2(((p.h + 11) % 12) + 1)); break;
        case 'i': out.push(pad2(p.mi)); break;
        case 'j': out.push(String(dayOfYear(p)).padStart(3, '0')); break;
        case 'k': out.push(String(p.h)); break;
        case 'l': out.push(String(((p.h + 11) % 12) + 1)); break;
        case 'M': out.push(MONTH_NAMES[p.m - 1]); break;
        case 'm': out.push(pad2(p.m)); break;
        case 'p': out.push(p.h < 12 ? 'AM' : 'PM'); break;
        case 'r': out.push(pad2(((p.h + 11) % 12) + 1) + ':' + pad2(p.mi) + ':' + pad2(p.s) + ' ' + (p.h < 12 ? 'AM' : 'PM')); break;
        case 'S': case 's': out.push(pad2(p.s)); break;
        case 'T': out.push(pad2(p.h) + ':' + pad2(p.mi) + ':' + pad2(p.s)); break;
        case 'U': out.push(pad2(weekOf(p, 0))); break;
        case 'u': out.push(pad2(weekOf(p, 1))); break;
        case 'V': out.push(pad2(weekOf(p, 2))); break;
        case 'v': out.push(pad2(weekOf(p, 3))); break;
        case 'W': out.push(DAY_NAMES[weekdayIndex(p)]); break;
        case 'w': out.push(String((weekdayIndex(p) + 1) % 7)); break;
        case 'X': out.push(String(weekYearOf(p, 2))); break;
        case 'x': out.push(String(weekYearOf(p, 3))); break;
        case 'Y': out.push(String(p.y).padStart(4, '0')); break;
        case 'y': out.push(pad2(p.y % 100)); break;
        case '%': out.push('%'); break;
        default: out.push('%' + spec);
      }
    }
    return out.join('');
  }
  function ordinal(n) {
    if (n % 100 >= 11 && n % 100 <= 13) return n + 'th';
    return n + (n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th');
  }

  function timeFormat(value, format) {
    const p = parseDateTime(value, true);
    if (!p || isNull(format)) return null;
    const timePart = p.timeOnly ? p : { ...p, timeOnly: true };
    return dateFormat('1970-01-01 ' + pad2(timePart.h) + ':' + pad2(timePart.mi) + ':' + pad2(timePart.s), format);
  }

  const STRFTIME_TOKENS = {
    'Y': '(\\d{4})', 'y': '(\\d{2})', 'm': '(\\d{1,2})', 'c': '(\\d{1,2})',
    'd': '(\\d{1,2})', 'e': '(\\d{1,2})', 'H': '(\\d{1,2})', 'k': '(\\d{1,2})',
    'h': '(\\d{1,2})', 'I': '(\\d{1,2})', 'i': '(\\d{1,2})', 's': '(\\d{1,2})',
    'S': '(\\d{1,2})', 'f': '(\\d{1,6})', 'p': '(AM|PM|am|pm)', 'M': '([A-Za-z]+)',
    'b': '([A-Za-z]+)', 'W': '([A-Za-z]+)', 'a': '([A-Za-z]+)'
  };
  function strToDate(value, format) {
    const s = asText(value), f = asText(format);
    if (s === null || f === null) return null;
    let regex = '', groups = [];
    for (let i = 0; i < f.length; i++) {
      const ch = f[i];
      if (ch !== '%') { regex += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
      const spec = f[++i] || '';
      if (STRFTIME_TOKENS[spec]) { regex += STRFTIME_TOKENS[spec]; groups.push(spec); }
      else if (spec === '%') regex += '%';
      else regex += '.';
    }
    const m = new RegExp('^' + regex + '$', 'i').exec(s.trim());
    if (!m) return null;
    const parts = { y: 0, m: 1, d: 1, h: 0, mi: 0, s: 0, us: 0, dateOnly: true };
    let pm = null;
    for (let i = 0; i < groups.length; i++) {
      const spec = groups[i], raw = m[i + 1];
      switch (spec) {
        case 'Y': parts.y = +raw; break;
        case 'y': parts.y = 2000 + +raw; break;
        case 'm': case 'c': parts.m = +raw; break;
        case 'd': case 'e': parts.d = +raw; break;
        case 'H': case 'k': case 'h': case 'I': parts.h = +raw; parts.dateOnly = false; break;
        case 'i': parts.mi = +raw; parts.dateOnly = false; break;
        case 's': case 'S': parts.s = +raw; parts.dateOnly = false; break;
        case 'f': parts.us = +(raw + '000000').slice(0, 6); break;
        case 'p': pm = raw.toUpperCase(); break;
        case 'M': parts.m = MONTH_NAMES.findIndex(x => x.toLowerCase() === raw.toLowerCase()) + 1; break;
        case 'b': parts.m = MONTH_NAMES.findIndex(x => x.slice(0, 3).toLowerCase() === raw.toLowerCase()) + 1; break;
        default: break;
      }
    }
    if (!parts.y) return null;
    if (pm === 'PM' && parts.h < 12) parts.h += 12;
    if (pm === 'AM' && parts.h === 12) parts.h = 0;
    if (!validParts(parts.y, parts.m, parts.d, parts.h, parts.mi, parts.s)) return null;
    return formatDateParts(parts, true);
  }

  function convertTz(value, fromTz, toTz) {
    const p = parseDateTime(value, true);
    if (!p) return null;
    if (isNull(fromTz) || isNull(toTz)) return null;
    const parseOffset = tz => {
      const s = String(tz).trim();
      const m = /^([+-])(\d{1,2}):(\d{2})$/.exec(s) || /^([+-])(\d{1,2})$/.exec(s);
      if (m) return (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + (+(m[3] || 0)));
      if (/^UTC$|^GMT$/i.test(s)) return 0;
      return null;
    };
    const from = parseOffset(fromTz), to = parseOffset(toTz);
    if (from === null || to === null) return null;
    const ms = partsToMs(p) - (from - to) * 60000;
    return formatDateParts(msToParts(ms, p.dateOnly), true);
  }

  /* =======================================================================
   * 3. JSON-függvények (MySQL 9 JSON-szemantika, JS-objektummal)
   * ===================================================================== */

  function parseJson(value) {
    if (isNull(value)) return { ok: false };
    if (typeof value === 'object' && !(value instanceof Uint8Array)) return { ok: true, value };
    const s = asText(value);
    if (s === null) return { ok: false };
    try { return { ok: true, value: JSON.parse(s) }; } catch (e) { return { ok: false }; }
  }
  function dumpJson(value) {
    try { return JSON.stringify(value); } catch (e) { return null; }
  }
  function jsonPathParts(path) {
    const s = asText(path);
    if (s === null) return null;
    if (s === '$') return [];
    if (!s.startsWith('$')) return null;
    const parts = [];
    const re = /\.([A-Za-z_$][\w$]*|"[^"]*")|\[\s*(\*|\d+)\s*\]/g;
    let m, last = 1;
    while ((m = re.exec(s))) {
      if (m.index !== last) return null;
      last = re.lastIndex;
      if (m[1] !== undefined) parts.push(m[1].startsWith('"') ? m[1].slice(1, -1) : m[1]);
      else parts.push(m[2] === '*' ? '*' : +m[2]);
    }
    return last === s.length ? parts : null;
  }
  function jsonWalk(root, parts) {
    let nodes = [root];
    for (const part of parts) {
      const next = [];
      for (const node of nodes) {
        if (part === '*') {
          if (Array.isArray(node)) next.push(...node);
          else if (node && typeof node === 'object') next.push(...Object.values(node));
        } else if (Array.isArray(node) && typeof part === 'number') {
          if (part < node.length) { next.push(node[part]); }
        } else if (node && typeof node === 'object' && part in node) {
          next.push(node[part]);
        }
      }
      nodes = next;
    }
    return nodes;
  }
  function jsonExtract(value, ...paths) {
    const doc = parseJson(value);
    if (!doc.ok) return null;
    const out = [];
    for (const path of paths) {
      const parts = jsonPathParts(path);
      if (!parts) return null;
      out.push(...jsonWalk(doc.value, parts));
    }
    if (!out.length) return null;
    return out.length === 1 ? dumpJson(out[0]) : dumpJson(out);
  }
  function jsonUnquote(value) {
    const s = asText(value);
    if (s === null) return null;
    if (!s.length) return null;
    const doc = parseJson(s);
    if (!doc.ok) return s;
    if (typeof doc.value === 'string') return doc.value;
    if (doc.value === null) return null;
    return typeof doc.value === 'object' ? dumpJson(doc.value) : String(doc.value);
  }
  function jsonQuote(value) {
    const doc = parseJson(value);
    return doc.ok ? dumpJson(doc.value) : dumpJson(asText(value));
  }
  function jsonContains(target, candidate) {
    const a = parseJson(target), b = parseJson(candidate);
    if (!a.ok || !b.ok) return null;
    /* MySQL: a jelölt lehet skalár, tömb vagy objektum; a célban való
       "benne van" viszonyt rekurzívan vizsgáljuk. */
    const found = (haystack, needle) => {
      if (needle === null) return haystack === null;
      if (typeof needle !== 'object') {
        if (Array.isArray(haystack)) return haystack.some(h => found(h, needle));
        return haystack === needle;
      }
      if (Array.isArray(needle)) {
        if (!Array.isArray(haystack)) return false;
        return needle.every(n => haystack.some(h => found(h, n)));
      }
      if (!haystack || typeof haystack !== 'object' || Array.isArray(haystack)) return false;
      return Object.keys(needle).every(k => k in haystack && found(haystack[k], needle[k]));
    };
    return found(a.value, b.value) ? 1 : 0;
  }
  function jsonItemType(value) {
    if (isNull(value)) return null;
    if (typeof value === 'object') return Array.isArray(value) ? 'ARRAY' : 'OBJECT';
    const s = asText(value);
    if (s === null) return null;
    const doc = parseJson(s);
    if (doc.ok) {
      const v = doc.value;
      if (v === null) return 'NULL';
      if (Array.isArray(v)) return 'ARRAY';
      if (typeof v === 'object') return 'OBJECT';
      if (typeof v === 'boolean') return 'BOOLEAN';
      if (typeof v === 'number') return Number.isInteger(v) ? 'INTEGER' : 'DOUBLE';
      return 'STRING';
    }
    if (/^(true|false)$/i.test(s)) return 'BOOLEAN';
    if (/^-?\d+$/.test(s)) return 'INTEGER';
    if (/^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(s)) return 'DOUBLE';
    if (s === 'null') return 'NULL';
    return 'STRING';
  }
  function jsonValid(value) {
    if (isNull(value)) return null;
    const doc = parseJson(value);
    return doc.ok ? 1 : 0;
  }
  function jsonArray(...values) {
    return dumpJson(values.map(v => { const d = parseJson(v); return d.ok ? d.value : v; }));
  }
  function jsonObject(...pairs) {
    if (pairs.length % 2) return null;
    const out = {};
    for (let i = 0; i < pairs.length; i += 2) {
      const key = asText(pairs[i]);
      if (key === null) return null;
      if (key in out) return null;
      const d = parseJson(pairs[i + 1]);
      out[key] = d.ok ? d.value : pairs[i + 1];
    }
    return dumpJson(out);
  }
  /* Végigvezet az úton, szükség esetén létrehozza a hiányzó szinteket
     (JSON_SET / JSON_INSERT viselkedése). */
  function jsonWalkCreate(rootNode, parts) {
    let node = rootNode;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (Array.isArray(node) && typeof key === 'number') {
        while (node.length < key) node.push(null);
        if (node[key] === null || node[key] === undefined) node[key] = {};
        node = node[key];
      } else if (node && typeof node === 'object' && !Array.isArray(node)) {
        if (!(key in node) || node[key] === null || typeof node[key] !== 'object') node[key] = {};
        node = node[key];
      } else return null;
    }
    return node;
  }
  /* A módosító függvények közös váza: minden út/érték párt sorban alkalmaz. */
  function jsonApplyPairs(value, args, apply) {
    let doc = parseJson(value);
    if (!doc.ok) return null;
    let current = doc.value;
    for (let i = 0; i + 1 < args.length; i += 2) {
      const parts = jsonPathParts(args[i]);
      if (!parts) return null;
      if (!parts.length) { current = args[i + 1]; continue; }
      current = apply(current, parts, args[i + 1]);
      if (current === null) return null;
    }
    return dumpJson(current);
  }
  function jsonSet(value, ...args) {
    return jsonApplyPairs(value, args, (root, parts, newValue) => {
      const node = jsonWalkCreate(root, parts);
      if (node === null) return null;
      const last = parts[parts.length - 1];
      if (Array.isArray(node) && typeof last === 'number') {
        while (node.length <= last) node.push(null);
        node[last] = newValue;
      } else if (node && typeof node === 'object') node[last] = newValue;
      else return null;
      return root;
    });
  }
  function jsonReplace(value, ...args) {
    return jsonApplyPairs(value, args, (root, parts, newValue) => {
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        node = Array.isArray(node) && typeof key === 'number'
          ? node[key]
          : (node && typeof node === 'object' ? node[key] : undefined);
        if (node === undefined || node === null) return root;   /* nincs mit átírni */
      }
      const last = parts[parts.length - 1];
      if (Array.isArray(node) && typeof last === 'number') { if (last < node.length) node[last] = newValue; }
      else if (node && typeof node === 'object' && last in node) node[last] = newValue;
      return root;
    });
  }
  function jsonInsert(value, ...args) {
    return jsonApplyPairs(value, args, (root, parts, newValue) => {
      const node = jsonWalkCreate(root, parts);
      if (node === null) return null;
      const last = parts[parts.length - 1];
      if (Array.isArray(node)) {
        /* Tömbnél a megadott indexre szúrunk be (a meglévő elemek nem
           tűnnek el); 'append' / nem szám index a végére fűz. */
        if (last === 'append' || typeof last !== 'number') node.push(newValue);
        else node.splice(Math.max(0, Math.min(last, node.length)), 0, newValue);
      } else if (node && typeof node === 'object') {
        /* MySQL JSON_INSERT: ha a kulcs MÁR létezik, nem módosít. */
        if (!(last in node)) node[last] = newValue;
      } else return null;
      return root;
    });
  }
  /* JSON_ARRAY_APPEND(dok, út, érték[, út, érték...]) */
  function jsonArrayAppend(value, ...args) {
    const doc = parseJson(value);
    if (!doc.ok) return null;
    if (!args.length || args.length % 2) return null;
    /* A MySQL balról jobbra halad, és minden lépés az előző eredményére épül. */
    let current = doc.value;
    for (let a = 0; a < args.length; a += 2) {
      const parts = jsonPathParts(args[a]);
      if (!parts) return null;
      let node = current;
      for (const key of parts) {
        if (Array.isArray(node) && typeof key === 'number') node = node[key];
        else if (node && typeof node === 'object') node = node[key];
        else return null;
      }
      if (!Array.isArray(node)) return null;
      node.push(args[a + 1]);
    }
    return dumpJson(current);
  }
  function jsonArrayInsert(value, ...args) {
    return jsonApplyPairs(value, args, (root, parts, newValue) => {
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        node = Array.isArray(node) && typeof key === 'number'
          ? node[key]
          : (node && typeof node === 'object' ? node[key] : undefined);
        if (node === undefined || node === null) return null;
      }
      const last = parts[parts.length - 1];
      if (!Array.isArray(node) || typeof last !== 'number') return null;
      node.splice(Math.max(0, Math.min(last, node.length)), 0, newValue);
      return root;
    });
  }
  /* JSON_SEARCH(dok, 'one'|'all', minta [, escape [, ...utak]]) */
  function jsonSearch(value, oneOrAll, searchStr, escape, ...paths) {
    const doc = parseJson(value);
    if (!doc.ok) return null;
    const needle = asText(searchStr);
    if (needle === null) return null;
    const all = String(oneOrAll || 'one').toLowerCase() === 'all';
    const results = [];
    /* A MySQL JSON_SEARCH mintája LIKE-minta: a % és _ mindig wildcard,
       az escape karakter (ha meg van adva) ezeket escape-eli. */
    const esc = isNull(escape) ? '' : String(escape);
    let pattern = '';
    for (let i = 0; i < needle.length; i++) {
      const ch = needle[i];
      if (esc && ch === esc && i + 1 < needle.length) {
        pattern += needle[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      } else if (ch === '%') pattern += '.*';
      else if (ch === '_') pattern += '.';
      else pattern += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    let rx;
    try { rx = new RegExp('^' + pattern + '$', 'is'); } catch (e) { return null; }
    const walk = (node, path) => {
      if (all && results.length && false) return;
      if (typeof node === 'string' && (needle === '' || rx.test(node))) results.push(path);
      if (Array.isArray(node)) node.forEach((v, i) => walk(v, path + '[' + i + ']'));
      else if (node && typeof node === 'object') for (const k of Object.keys(node)) walk(node[k], path + '.' + k);
    };
    const roots = paths.length ? paths.map(p => jsonPathParts(p)).filter(Boolean) : [[]];
    for (const parts of roots) {
      const nodes = parts.length ? jsonWalk(doc.value, parts) : [doc.value];
      let base = '$' + parts.map(p => typeof p === 'number' ? '[' + p + ']' : '.' + p).join('');
      for (const node of nodes) walk(node, base);
      if (!all && results.length) break;
    }
    if (!results.length) return null;
    return all ? dumpJson(results) : dumpJson(results[0]);
  }

  function jsonRemove(value, ...paths) {
    const doc = parseJson(value);
    if (!doc.ok) return null;
    for (const path of paths) {
      const parts = jsonPathParts(path);
      if (!parts || !parts.length) continue;
      let node = doc.value;
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        node = Array.isArray(node) ? node[key] : (node && typeof node === 'object' ? node[key] : undefined);
        if (node === undefined) break;
      }
      const last = parts[parts.length - 1];
      if (Array.isArray(node) && typeof last === 'number') node.splice(last, 1);
      else if (node && typeof node === 'object') delete node[last];
    }
    return dumpJson(doc.value);
  }
  function jsonKeys(value) {
    const doc = parseJson(value);
    if (!doc.ok) return null;
    if (Array.isArray(doc.value)) return dumpJson(doc.value.map((_, i) => String(i)));
    if (doc.value && typeof doc.value === 'object') return dumpJson(Object.keys(doc.value));
    return null;
  }
  function jsonLength(value) {
    const doc = parseJson(value);
    if (!doc.ok) return null;
    if (Array.isArray(doc.value)) return doc.value.length;
    if (doc.value && typeof doc.value === 'object') return Object.keys(doc.value).length;
    return 1;
  }
  function jsonArrayLength(value) {
    const doc = parseJson(value);
    return doc.ok && Array.isArray(doc.value) ? doc.value.length : null;
  }
  function jsonMergePatch(a, ...rest) {
    let target = parseJson(a);
    if (!target.ok) return null;
    let value = target.value;
    for (const patchRaw of rest) {
      const patch = parseJson(patchRaw);
      if (!patch.ok) return null;
      value = mergePatchApply(value, patch.value);
    }
    return dumpJson(value);
  }
  function mergePatchApply(target, patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
    if (target === null || typeof target !== 'object' || Array.isArray(target)) target = {};
    for (const key of Object.keys(patch)) {
      const p = patch[key];
      if (p === null) delete target[key];
      else target[key] = mergePatchApply(target[key], p);
    }
    return target;
  }
  function jsonOverlaps(a, b) {
    const x = parseJson(a), y = parseJson(b);
    if (!x.ok || !y.ok) return null;
    const nx = Array.isArray(x.value) ? x.value : [x.value];
    const ny = Array.isArray(y.value) ? y.value : [y.value];
    return nx.some(v => ny.some(w => dumpJson(v) === dumpJson(w))) ? 1 : 0;
  }

  /* =======================================================================
   * 4. Skalárfüggvények jegyzéke + regisztráció az sql.js motorba
   * ---------------------------------------------------------------------
   * Minden bejegyzés: [név, függvény, aritás-lista, NULL-átengedés]
   * A NULL-átengedés azt jelenti, hogy NULL argumentumra automatikusan NULL
   * lesz az eredmény (a MySQL legtöbb függvénye így viselkedik).
   * ===================================================================== */

  const scalars = [];
  function def(name, fn, arity, options) {
    const list = arity === '*' ? [-1] : (Array.isArray(arity) ? arity : [arity]);
    scalars.push({ name, fn, arity: list, passNull: !!(options && options.passNull) });
  }

  /* --- Matematika --- */
  def('ABS', v => Math.abs(num(v)), 1);
  def('SIGN', v => { const n = num(v); return n === null ? null : Math.sign(n); }, 1);
  def('CEIL', v => Math.ceil(num(v)), 1);
  def('CEILING', v => Math.ceil(num(v)), 1);
  def('FLOOR', v => Math.floor(num(v)), 1);
  def('ROUND', (v, p) => roundTo(v, p), [1, 2]);
  def('TRUNCATE', (v, p) => truncateTo(v, p), 2);
  def('MOD', (a, b) => modulo(a, b), 2);
  def('POW', (a, b) => { const x = num(a), y = num(b); return x === null || y === null ? null : Math.pow(x, y); }, 2);
  def('POWER', (a, b) => { const x = num(a), y = num(b); return x === null || y === null ? null : Math.pow(x, y); }, 2);
  def('EXP', v => Math.exp(num(v)), 1);
  def('LN', v => Math.log(num(v)), 1);
  def('LOG', (v, base) => base === undefined ? Math.log10(num(v)) : Math.log(num(v)) / Math.log(num(base)), [1, 2]);
  def('LOG2', v => Math.log2(num(v)), 1);
  def('LOG10', v => Math.log10(num(v)), 1);
  def('SQRT', v => Math.sqrt(num(v)), 1);
  def('PI', () => Math.PI, 0);
  def('SIN', v => Math.sin(num(v)), 1);
  def('COS', v => Math.cos(num(v)), 1);
  def('TAN', v => Math.tan(num(v)), 1);
  def('COT', v => 1 / Math.tan(num(v)), 1);
  def('ASIN', v => Math.asin(num(v)), 1);
  def('ACOS', v => Math.acos(num(v)), 1);
  def('ATAN', (v, b) => b === undefined ? Math.atan(num(v)) : Math.atan2(num(v), num(b)), [1, 2]);
  def('ATAN2', (a, b) => Math.atan2(num(a), num(b)), 2);
  def('DEGREES', v => num(v) * 180 / Math.PI, 1);
  def('RADIANS', v => num(v) * Math.PI / 180, 1);
  def('RAND', (seed) => {
    if (seed === undefined || isNull(seed)) return Math.random();
    /* Determinisztikus álvéletlen az adott magra (kis LCG). */
    let s = (truncInt(seed) >>> 0) || 1;
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s % 1000000) / 1000000;
  }, [0, 1], { passNull: true });
  def('CRC32', v => crc32(v), 1, { passNull: true });
  def('CONV', (v, a, b) => convertBase(v, a, b), 3, { passNull: true });

  /* --- Egész / bitműveletek --- */
  def('BIT_COUNT', v => bitCount(v), 1, { passNull: true });

  /* --- Szöveg --- */
  const concat = (...values) => values.some(isNull) ? null : values.map(asText).join('');
  def('CONCAT', concat, '*', { passNull: true });
  const concatWs = (sep, ...values) => isNull(sep) ? null : values.filter(v => !isNull(v)).map(asText).join(asText(sep));
  def('CONCAT_WS', concatWs, '*', { passNull: true });
  def('LENGTH', v => octetLength(v), 1, { passNull: true });
  def('OCTET_LENGTH', v => octetLength(v), 1, { passNull: true });
  def('BIT_LENGTH', v => { const n = octetLength(v); return n === null ? null : n * 8; }, 1, { passNull: true });
  def('CHAR_LENGTH', v => charLength(v), 1, { passNull: true });
  def('CHARACTER_LENGTH', v => charLength(v), 1, { passNull: true });
  def('UPPER', v => isNull(v) ? null : asText(v).toLocaleUpperCase(HU), 1, { passNull: true });
  def('UCASE', v => isNull(v) ? null : asText(v).toLocaleUpperCase(HU), 1, { passNull: true });
  def('LOWER', v => isNull(v) ? null : asText(v).toLocaleLowerCase(HU), 1, { passNull: true });
  def('LCASE', v => isNull(v) ? null : asText(v).toLocaleLowerCase(HU), 1, { passNull: true });
  def('LEFT', (v, n) => { const c = codePoints(v); return c === null || isNull(n) ? null : c.slice(0, Math.max(0, truncInt(n))).join(''); }, 2, { passNull: true });
  def('RIGHT', (v, n) => { const c = codePoints(v); if (c === null || isNull(n)) return null; const k = Math.max(0, truncInt(n)); return k === 0 ? '' : c.slice(-k).join(''); }, 2, { passNull: true });
  def('SUBSTRING', (v, p, l) => substringOf(v, p, l), [2, 3], { passNull: true });
  def('SUBSTR', (v, p, l) => substringOf(v, p, l), [2, 3], { passNull: true });
  def('MID', (v, p, l) => substringOf(v, p, l), [2, 3], { passNull: true });
  def('SUBSTRING_INDEX', (v, d, c) => substringIndex(v, d, c), 3, { passNull: true });
  def('LOCATE', (needle, haystack, start) => {
    const h = asText(haystack), n = asText(needle);
    if (h === null || n === null) return null;
    /* Karakteralapú keresés: a kezdőpozíció is karakterben értendő. */
    const chars = Array.from(h);
    const from = isNull(start) ? 0 : Math.min(chars.length, Math.max(0, truncInt(start) - 1));
    const index = chars.slice(from).join('').indexOf(n);
    if (index < 0) return 0;
    return from + Array.from(chars.slice(from).join('').slice(0, index)).length + 1;
  }, [2, 3], { passNull: true });
  def('POSITION', (needle, haystack) => {
    const h = asText(haystack), n = asText(needle);
    if (h === null || n === null) return null;
    const index = h.indexOf(n);
    return index < 0 ? 0 : Array.from(h.slice(0, index)).length + 1;
  }, 2, { passNull: true });
  def('INSTR', (haystack, needle) => {
    const h = asText(haystack), n = asText(needle);
    if (h === null || n === null) return null;
    const index = h.indexOf(n);
    return index < 0 ? 0 : Array.from(h.slice(0, index)).length + 1;
  }, 2, { passNull: true });
  def('REPLACE', (s, from, to) => {
    const st = asText(s), f = asText(from), t = asText(to);
    if (st === null || f === null || t === null) return null;
    return !f ? st : st.split(f).join(t);
  }, 3, { passNull: true });
  def('TRIM', v => { const s = asText(v); return s === null ? null : s.replace(/^ +| +$/g, ''); }, 1, { passNull: true });
  def('LTRIM', v => { const s = asText(v); return s === null ? null : s.replace(/^ +/, ''); }, 1, { passNull: true });
  def('RTRIM', v => { const s = asText(v); return s === null ? null : s.replace(/ +$/, ''); }, 1, { passNull: true });
  def('MYSQL_TRIM_DIR', (v, rem, mode) => trimDirection(v, rem, mode), 3, { passNull: true });
  def('REPEAT', (v, n) => repeatText(v, n), 2, { passNull: true });
  def('SPACE', n => repeatText(' ', n), 1, { passNull: true });
  def('LPAD', (v, n, p) => padText(v, n, p, true), 3, { passNull: true });
  def('RPAD', (v, n, p) => padText(v, n, p, false), 3, { passNull: true });
  def('REVERSE', v => { const c = codePoints(v); return c === null ? null : c.reverse().join(''); }, 1, { passNull: true });
  def('INSERT', (v, p, l, n) => insertString(v, p, l, n), 4, { passNull: true });
  def('ELT', (i, ...rest) => elt(i, ...rest), '*', { passNull: true });
  def('FIELD', (n, ...rest) => fieldOf(n, ...rest), '*', { passNull: true });
  def('FIND_IN_SET', (n, l) => findInSet(n, l), 2, { passNull: true });
  def('MAKE_SET', (b, ...rest) => makeSet(b, ...rest), '*', { passNull: true });
  def('ASCII', v => { const b = asBytes(v); return b === null ? null : (b.length ? b[0] : 0); }, 1, { passNull: true });
  def('ORD', v => {
    const s = asText(v);
    if (s === null) return null;
    if (!s.length) return 0;
    return s.codePointAt(0);
  }, 1, { passNull: true });
  def('CHAR', (...values) => values.map(v => { const n = truncInt(v); return n === null ? '' : String.fromCodePoint(((n % 0x110000) + 0x110000) % 0x110000); }).join(''), [1, 2, 3, 4, 5, 6], { passNull: true });
  def('HEX', v => hexOf(v), 1, { passNull: true });
  def('BIN', v => { const n = truncInt(v); return n === null ? null : (n >>> 0).toString(2); }, 1, { passNull: true });
  def('OCT', v => { const n = truncInt(v); return n === null ? null : (n >>> 0).toString(8); }, 1, { passNull: true });
  def('CHARSET', () => 'utf8mb4', 1, { passNull: true });
  def('COLLATION', () => 'utf8mb4_hungarian_ci', 1, { passNull: true });
  def('CHARS', () => 'utf8mb4', [0, 1], { passNull: true });
  /* Egyszerű térinformatika: POINT + távolság (síkban, fokban). */
  def('ST_POINT', (x, y) => {
    const px = num(x), py = num(y);
    return px === null || py === null ? null : 'POINT(' + px + ' ' + py + ')';
  }, 2, { passNull: true });
  def('POINT', (x, y) => {
    const px = num(x), py = num(y);
    return px === null || py === null ? null : 'POINT(' + px + ' ' + py + ')';
  }, 2, { passNull: true });
  const pointCoords = v => {
    const m = /POINT\(\s*(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s*\)/.exec(String(v == null ? '' : v));
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  };
  def('ST_X', v => { const p = pointCoords(v); return p ? p.x : null; }, 1, { passNull: true });
  def('ST_Y', v => { const p = pointCoords(v); return p ? p.y : null; }, 1, { passNull: true });
  def('ST_DISTANCE', (a, b) => {
    const pa = pointCoords(a), pb = pointCoords(b);
    if (!pa || !pb) return null;
    return Math.hypot(pa.x - pb.x, pa.y - pb.y);
  }, 2, { passNull: true });
  def('ST_AS_TEXT', v => isNull(v) ? null : String(v), 1, { passNull: true });
  def('ST_ASTEXT', v => isNull(v) ? null : String(v), 1, { passNull: true });
  def('UUID', () => {
    const hex = '0123456789abcdef';
    let s = '';
    for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
    return s.slice(0, 8) + '-' + s.slice(8, 12) + '-4' + s.slice(13, 16) + '-a' + s.slice(17, 20) + '-' + s.slice(20, 32);
  }, 0);
  def('UUID_SHORT', () => Math.floor(Date.now() / 1000) * 1000000 + Math.floor(Math.random() * 1000000), 0);
  def('MYSQL_INSERT', (v, p, l, n) => insertString(v, p, l, n), 4, { passNull: true });
  /* Hálózati címek: INET_ATON / INET_NTOA / INET6_ATON / INET6_NTOA. */
  def('INET_ATON', v => {
    const s = asText(v);
    if (s === null) return null;
    const m = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\s*$/.exec(s);
    if (!m) return null;
    const parts = m.slice(1).map(Number);
    if (parts.some(n => n > 255)) return null;
    return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  }, 1, { passNull: true });
  def('INET_NTOA', v => {
    const n = truncInt(v);
    if (n === null || n < 0) return null;
    const x = n >>> 0;
    return [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255].join('.');
  }, 1, { passNull: true });
  def('UNHEX', v => unhexOf(v), 1, { passNull: true });
  def('TO_BASE64', v => base64Encode(v), 1, { passNull: true });
  def('FROM_BASE64', v => base64Decode(v), 1, { passNull: true });
  def('STRCMP', (a, b) => strcmp(a, b), 2, { passNull: true });
  /* RLIKE / REGEXP: a MySQL-ben ugyanaz; az SQLite-ban REGEXP operátor van,
     a hozzá tartozó függvényt regisztráljuk. */
  def('REGEXP_LIKE', (v, p, flags) => regexpLike(v, p, flags), [2, 3], { passNull: true });
  def('RLIKE', (v, p) => regexpLike(v, p), 2, { passNull: true });
  def('REGEXP_REPLACE', (v, p, r, pos, occ, flags) => regexpReplace(v, p, r, pos, occ, flags), [3, 4, 5, 6], { passNull: true });
  def('REGEXP_SUBSTR', (v, p, pos, occ, flags) => regexpSubstr(v, p, pos, occ, flags), [2, 3, 4, 5], { passNull: true });
  def('REGEXP_INSTR', (v, p, pos, occ, ret, flags) => regexpInstr(v, p, pos, occ, ret, flags), [2, 3, 4, 5, 6], { passNull: true });
  def('SOUNDEX', v => {
    const s = asText(v);
    if (s === null) return null;
    const letters = s.toUpperCase().replace(/[^A-Z]/g, '');
    if (!letters) return '';
    const map = { B: 1, F: 1, P: 1, V: 1, C: 2, G: 2, J: 2, K: 2, Q: 2, S: 2, X: 2, Z: 2, D: 3, T: 3, L: 4, M: 5, N: 5, R: 6 };
    let out = letters[0], last = map[letters[0]] || 0;
    for (let i = 1; i < letters.length && out.length < 4; i++) {
      const code = map[letters[i]] || 0;
      if (code && code !== last) out += code;
      last = code;
    }
    return (out + '000').slice(0, 4);
  }, 1, { passNull: true });
  def('QUOTE', v => {
    if (isNull(v)) return 'NULL';
    if (v instanceof Uint8Array) return "X'" + hexOf(v) + "'";
    return "'" + asText(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\0/g, '\\0').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\x1a/g, '\\Z') + "'";
  }, 1, { passNull: true });
  def('FORMAT', (v, d, l) => formatNumber(v, d === undefined ? 0 : d, l), [2, 3], { passNull: true });
  def('EXPORT_SET', (bits, on, off, sep, count) => {
    const n = truncInt(bits);
    if (n === null) return null;
    const parts = [];
    const total = isNull(count) ? 64 : clamp(truncInt(count), 0, 64);
    /* 64 bites bitvizsgálat: a JS-beli 1 << 31 negatív lenne, ezért
       hatvánnyal számolunk. */
    const value = Math.abs(n);
    for (let i = 0; i < total; i++) {
      const bit = Math.floor(value / Math.pow(2, i)) % 2 === 1;
      parts.push(bit ? asText(on) : asText(off));
    }
    return parts.join(isNull(sep) ? ',' : asText(sep));
  }, [3, 4, 5], { passNull: true });

  /* --- Titkosítás / tömörítés --- */
  def('MD5', v => {
    const s = asText(v);
    if (s === null) return null;
    return md5Hex(s);
  }, 1, { passNull: true });
  def('SHA1', v => {
    const s = asText(v);
    if (s === null) return null;
    return sha1Hex(s);
  }, 1, { passNull: true });
  def('SHA2', (v, bits) => {
    const s = asText(v);
    if (s === null) return null;
    const n = isNull(bits) ? 256 : truncInt(bits);
    return sha2Hex(s, n);
  }, 2, { passNull: true });

  /* --- NULL-kezelés és feltételek --- */
  def('IFNULL', (a, b) => isNull(a) ? b : a, 2, { passNull: true });
  def('COALESCE', (...values) => { for (const v of values) if (!isNull(v)) return v; return null; }, '*', { passNull: true });
  def('NULLIF', (a, b) => {
    if (isNull(a) || isNull(b)) return null;
    const na = num(a), nb = num(b);
    const sameNumber = na !== null && nb !== null && na === nb;
    return (asText(a) === asText(b) || sameNumber) ? null : a;
  }, 2, { passNull: true });
  def('IF', (cond, yes, no) => num(cond) ? yes : no, 3, { passNull: true });
  def('ISNULL', v => isNull(v) ? 1 : 0, 1, { passNull: true });
  def('GREATEST', (...values) => {
    if (!values.length || values.some(isNull)) return null;
    let best = values[0];
    for (const v of values) if (compareValues(v, best) > 0) best = v;
    return best;
  }, '*', { passNull: true });
  def('LEAST', (...values) => {
    if (!values.length || values.some(isNull)) return null;
    let best = values[0];
    for (const v of values) if (compareValues(v, best) < 0) best = v;
    return best;
  }, '*', { passNull: true });

  function compareValues(a, b) {
    const na = num(a), nb = num(b);
    if (typeof a === 'number' || typeof b === 'number') {
      if (na !== null && nb !== null) return na === nb ? 0 : (na < nb ? -1 : 1);
      return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0);
    }
    const sa = asText(a), sb = asText(b);
    if (sa === sb) return 0;
    return sa < sb ? -1 : 1;
  }

  /* --- Típus- és rendszerinformáció --- */
  def('VERSION', () => VERSION, 0);
  def('DATABASE', () => defaultState.schema === 'main' ? 'adatbazis' : defaultState.schema, 0);
  def('SCHEMA', () => defaultState.schema === 'main' ? 'adatbazis' : defaultState.schema, 0);
  def('USER', () => 'tanulo@localhost', 0);
  def('CURRENT_USER', () => 'tanulo@localhost', 0);
  def('SESSION_USER', () => 'tanulo@localhost', 0);
  def('SYSTEM_USER', () => 'tanulo@localhost', 0);
  def('CONNECTION_ID', () => 1, 0);
  def('ROW_COUNT', () => defaultState.rowCount === undefined ? 0 : defaultState.rowCount, 0);
  def('FOUND_ROWS', () => defaultState.foundRows === undefined ? 0 : defaultState.foundRows, 0);
  def('LAST_INSERT_ID', v => {
    if (!isNull(v)) { defaultState.lastInsertId = truncInt(v); return defaultState.lastInsertId; }
    return defaultState.lastInsertId === undefined ? 0 : defaultState.lastInsertId;
  }, [0, 1], { passNull: true });

  /* =======================================================================
   * 4/b. Hash-segédek (MD5, SHA-1, SHA-2) – önálló, függőség nélküli
   * ===================================================================== */

  const HEX = '0123456789abcdef';
  const bytesHex = bytes => { let out = ''; for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15]; return out; };

  function md5Hex(text) {
    const bytes = encoder.encode(text);
    const bitLen = bytes.length * 8;
    const padded = (((bytes.length + 8) >> 6) + 1) << 6;
    const buffer = new Uint8Array(padded);
    buffer.set(bytes);
    buffer[bytes.length] = 0x80;
    const view = new DataView(buffer.buffer);
    view.setUint32(padded - 8, bitLen >>> 0, true);
    view.setUint32(padded - 4, Math.floor(bitLen / 4294967296), true);

    let a0 = 0x67452301, b0 = 0xEFCDAB89, c0 = 0x98BADCFE, d0 = 0x10325476;
    const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    const K = new Int32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

    for (let offset = 0; offset < padded; offset += 64) {
      const M = new Int32Array(16);
      for (let i = 0; i < 16; i++) M[i] = view.getInt32(offset + i * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) | 0;
        A = D; D = C; C = B;
        B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const out = new Uint8Array(16);
    const outView = new DataView(out.buffer);
    outView.setInt32(0, a0, true); outView.setInt32(4, b0, true);
    outView.setInt32(8, c0, true); outView.setInt32(12, d0, true);
    return bytesHex(out);
  }

  function sha1Hex(text) {
    const bytes = encoder.encode(text);
    const bitLen = bytes.length * 8;
    const padded = (((bytes.length + 8) >> 6) + 1) << 6;
    const buffer = new Uint8Array(padded);
    buffer.set(bytes);
    buffer[bytes.length] = 0x80;
    const view = new DataView(buffer.buffer);
    view.setUint32(padded - 8, Math.floor(bitLen / 4294967296));
    view.setUint32(padded - 4, bitLen >>> 0);

    let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    const w = new Int32Array(80);
    for (let offset = 0; offset < padded; offset += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4);
      for (let i = 16; i < 80; i++) {
        const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
        w[i] = (x << 1) | (x >>> 31);
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let i = 0; i < 80; i++) {
        let f, k;
        if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
        else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
        e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    const out = new Uint8Array(20);
    const outView = new DataView(out.buffer);
    [h0, h1, h2, h3, h4].forEach((h, i) => outView.setInt32(i * 4, h));
    return bytesHex(out);
  }

  function sha2Hex(text, bits) {
    /* A MySQL a 224, 256, 384, 512 és 0 értéket fogadja el (a 0 = 256);
       minden más értékre NULL-t ad. */
    const size = bits === 0 ? 256
      : (bits === 224 || bits === 256 || bits === 384 || bits === 512) ? bits
      : null;
    if (size === null) return null;
    return sha2Sync(encoder.encode(text), size);
  }

  const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function sha2Sync(bytes, size) {
    const is512 = size === 384 || size === 512;
    const H = size === 224 ? new Uint32Array([0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4])
      : size === 384 ? new Uint32Array([0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939])
        : size === 512 ? new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
          : new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    if (is512) return sha512Sync(bytes, size);
    const bitLen = bytes.length * 8;
    const padded = (((bytes.length + 8) >> 6) + 1) << 6;
    const buffer = new Uint8Array(padded);
    buffer.set(bytes);
    buffer[bytes.length] = 0x80;
    const view = new DataView(buffer.buffer);
    view.setUint32(padded - 8, Math.floor(bitLen / 4294967296));
    view.setUint32(padded - 4, bitLen >>> 0);
    const w = new Uint32Array(64);
    for (let offset = 0; offset < padded; offset += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
        const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    const words = size === 224 ? H.slice(0, 7) : H;
    let out = '';
    for (const word of words) out += word.toString(16).padStart(8, '0');
    return out;
  }

  const SHA512_K = [
    '428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc',
    '3956c25bf348b538', '59f111f1b605d019', '923f82a4af194f9b', 'ab1c5ed5da6d8118',
    'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2',
    '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694',
    'e49b69c19ef14ad2', 'efbe4786384f25e3', '0fc19dc68b8cd5b5', '240ca1cc77ac9c65',
    '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5',
    '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4',
    'c6e00bf33da88fc2', 'd5a79147930aa725', '06ca6351e003826f', '142929670a0e6e70',
    '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df',
    '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b',
    'a2bfe8a14cf10364', 'a81a664bbc423001', 'c24b8b70d0f89791', 'c76c51a30654be30',
    'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8',
    '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8',
    '391c0cb3c5c95a63', '4ed8aa4ae3418acb', '5b9cca4f7763e373', '682e6ff3d6b2b8a3',
    '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec',
    '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b',
    'ca273eceea26619c', 'd186b8c721c0c207', 'eada7dd6cde0eb1e', 'f57d4f7fee6ed178',
    '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b',
    '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c',
    '4cc5d4becb3e42b6', '597f299cfc657e2a', '5fcb6fab3ad6faec', '6c44198c4a475817'
  ].map(h => [parseInt(h.slice(0, 8), 16), parseInt(h.slice(8), 16)]);

  function sha512Sync(bytes, size) {
    /* BigInt-alapú SHA-512/384 – pontos, de csak ritkán használt útvonal. */
    const is384 = size === 384;
    const H = (is384 ? [
      0xcbbb9d5dc1059ed8n, 0x629a292a367cd507n, 0x9159015a3070dd17n, 0x152fecd8f70e5939n,
      0x67332667ffc00b31n, 0x8eb44a8768581511n, 0xdb0c2e0d64f98fa7n, 0x47b5481dbefa4fa4n
    ] : [
      0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
      0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n
    ]).slice();
    const MASK = (1n << 64n) - 1n;
    const rotr = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & MASK;
    const bitLen = BigInt(bytes.length) * 8n;
    const padded = (((bytes.length + 16) >> 7) + 1) << 7;
    const buffer = new Uint8Array(padded);
    buffer.set(bytes);
    buffer[bytes.length] = 0x80;
    const view = new DataView(buffer.buffer);
    view.setBigUint64(padded - 8, bitLen);
    const w = new Array(80).fill(0n);
    for (let offset = 0; offset < padded; offset += 128) {
      for (let i = 0; i < 16; i++) w[i] = view.getBigUint64(offset + i * 8);
      for (let i = 16; i < 80; i++) {
        const s0 = rotr(w[i - 15], 1) ^ rotr(w[i - 15], 8) ^ (w[i - 15] >> 7n);
        const s1 = rotr(w[i - 2], 19) ^ rotr(w[i - 2], 61) ^ (w[i - 2] >> 6n);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & MASK;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 80; i++) {
        const S1 = rotr(e, 14) ^ rotr(e, 18) ^ rotr(e, 41);
        const ch = (e & f) ^ (~e & MASK & g);
        const t1 = (h + S1 + ch + (BigInt(SHA512_K[i][0]) << 32n) + BigInt(SHA512_K[i][1]) + w[i]) & MASK;
        const S0 = rotr(a, 28) ^ rotr(a, 34) ^ rotr(a, 39);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) & MASK;
        h = g; g = f; f = e; e = (d + t1) & MASK; d = c; c = b; b = a; a = (t1 + t2) & MASK;
      }
      H[0] = (H[0] + a) & MASK; H[1] = (H[1] + b) & MASK; H[2] = (H[2] + c) & MASK; H[3] = (H[3] + d) & MASK;
      H[4] = (H[4] + e) & MASK; H[5] = (H[5] + f) & MASK; H[6] = (H[6] + g) & MASK; H[7] = (H[7] + h) & MASK;
    }
    const words = is384 ? H.slice(0, 6) : H;
    return words.map(x => x.toString(16).padStart(16, '0')).join('');
  }

  /* =======================================================================
   * 4/c. Dátum- és időfüggvények regisztrációja
   * ===================================================================== */

  const now = () => new Date();
  function nowString() { return localString(now()); }
  function localString(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /* A NOW(3) / CURDATE(3) alakú hívásoknál a MySQL csak a törtmásodpercet
     veszi figyelembe; az SQLite-motornak nincs rá szüksége. */
  const ignorePrecision = () => nowString();
  def('NOW', ignorePrecision, [0, 1]);
  def('SYSDATE', ignorePrecision, [0, 1]);
  def('CURRENT_TIMESTAMP', () => nowString(), [0, 1]);
  def('LOCALTIME', () => nowString(), [0, 1]);
  def('LOCALTIMESTAMP', () => nowString(), [0, 1]);
  def('CURDATE', () => localString(now()).slice(0, 10), [0, 1]);
  def('CURRENT_DATE', () => localString(now()).slice(0, 10), [0, 1]);
  def('CURTIME', () => localString(now()).slice(11), [0, 1]);
  def('CURRENT_TIME', () => localString(now()).slice(11), [0, 1]);
  def('UTC_DATE', () => new Date().toISOString().slice(0, 10), [0, 1]);
  def('UTC_TIME', () => new Date().toISOString().slice(11, 19), [0, 1]);
  def('UTC_TIMESTAMP', () => new Date().toISOString().slice(0, 19).replace('T', ' '), [0, 1]);
  def('DATE', v => mysqlDate(v), 1, { passNull: true });
  def('TIME', v => mysqlTime(v), 1, { passNull: true });
  def('TIMESTAMP', (v, t) => {
    const d = mysqlDate(v);
    if (d === null) return null;
    if (isNull(t)) return d + ' 00:00:00';
    const tm = parseDateTime(t, true);
    return tm ? d + ' ' + pad2(tm.h) + ':' + pad2(tm.mi) + ':' + pad2(tm.s) : d + ' 00:00:00';
  }, [1, 2], { passNull: true });
  def('YEAR', v => fieldOfDate(v, p => p.y), 1, { passNull: true });
  def('MONTH', v => fieldOfDate(v, p => p.m), 1, { passNull: true });
  def('DAY', v => fieldOfDate(v, p => p.d), 1, { passNull: true });
  def('DAYOFMONTH', v => fieldOfDate(v, p => p.d), 1, { passNull: true });
  def('DAYOFWEEK', v => fieldOfDate(v, p => (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 1)), 1, { passNull: true });
  def('DAYOFYEAR', v => fieldOfDate(v, p => dayOfYear(p)), 1, { passNull: true });
  def('WEEKDAY', v => fieldOfDate(v, p => weekdayIndex(p)), 1, { passNull: true });
  def('QUARTER', v => fieldOfDate(v, p => Math.floor((p.m - 1) / 3) + 1), 1, { passNull: true });
  def('WEEK', (v, m) => fieldOfDate(v, p => weekOf(p, m)), [1, 2], { passNull: true });
  def('WEEKOFYEAR', v => fieldOfDate(v, p => weekOf(p, 3)), 1, { passNull: true });
  def('YEARWEEK', (v, m) => {
    const p = dateArg(v);
    if (!p) return null;
    return yearWeekOf(p, m);
  }, [1, 2], { passNull: true });
  /* A HOUR/MINUTE/SECOND a MySQL-ben csak idő- vagy dátum-idő értéket fogad
     el: puszta dátumnál NULL, puszta időnél viszont az idő mezőjét adja. */
  function timeField(v, pick) {
    const p = parseDateTime(v, true);
    if (!p) return null;
    if (p.timeOnly) return pick(p);
    if (p.dateOnly) return null;
    return pick(p);
  }
  def('HOUR', v => timeField(v, p => p.h), 1, { passNull: true });
  def('MINUTE', v => timeField(v, p => p.mi), 1, { passNull: true });
  def('SECOND', v => timeField(v, p => p.s), 1, { passNull: true });
  def('MICROSECOND', v => timeField(v, p => p.us), 1, { passNull: true });
  def('MONTHNAME', v => fieldOfDate(v, p => MONTH_NAMES[p.m - 1]), 1, { passNull: true });
  def('DAYNAME', v => fieldOfDate(v, p => DAY_NAMES[weekdayIndex(p)]), 1, { passNull: true });
  def('LAST_DAY', v => lastDayOf(v), 1, { passNull: true });
  def('DATE_ADD', (v, u, n) => n === undefined ? dateAdd(v, 'DAY', u) : dateAdd(v, u, n), [2, 3], { passNull: true });
  def('ADDDATE', (v, u, n) => {
    /* Kétargumentumos alak: ADDDATE(dátum, napok). */
    if (n === undefined) return dateAdd(v, 'DAY', u);
    return dateAdd(v, u, n);
  }, [2, 3], { passNull: true });
  def('DATE_SUB', (v, u, n) => n === undefined ? dateSub(v, 'DAY', u) : dateSub(v, u, n), [2, 3], { passNull: true });
  def('SUBDATE', (v, u, n) => {
    if (n === undefined) return dateSub(v, 'DAY', u);
    return dateSub(v, u, n);
  }, [2, 3], { passNull: true });
  def('ADDTIME', (a, b) => addtime(a, b), 2, { passNull: true });
  def('SUBTIME', (a, b) => subtime(a, b), 2, { passNull: true });
  def('DATEDIFF', (a, b) => datediff(a, b), 2, { passNull: true });
  def('TIMEDIFF', (a, b) => timediff(a, b), 2, { passNull: true });
  def('TIMESTAMPDIFF', (u, a, b) => timestampdiff(u, a, b), 3, { passNull: true });
  def('TIMESTAMPADD', (u, n, v) => timestampadd(u, n, v), 3, { passNull: true });
  def('SEC_TO_TIME', v => secToTime(v), 1, { passNull: true });
  def('TIME_TO_SEC', v => timeToSec(v), 1, { passNull: true });
  def('TO_DAYS', v => toDays(v), 1, { passNull: true });
  def('FROM_DAYS', v => fromDays(v), 1, { passNull: true });
  def('TO_SECONDS', v => toSeconds(v), 1, { passNull: true });
  def('UNIX_TIMESTAMP', v => unixTimestamp(v), [0, 1], { passNull: true });
  def('FROM_UNIXTIME', (v, f) => fromUnixtime(v, f), [1, 2], { passNull: true });
  def('MAKEDATE', (y, d) => makeDate(y, d), 2, { passNull: true });
  def('MAKETIME', (h, m, s) => makeTime(h, m, s), 3, { passNull: true });
  def('PERIOD_ADD', (p, m) => periodAdd(p, m), 2, { passNull: true });
  def('PERIOD_DIFF', (a, b) => periodDiff(a, b), 2, { passNull: true });
  def('DATE_FORMAT', (v, f) => dateFormat(v, f), 2, { passNull: true });
  def('TIME_FORMAT', (v, f) => timeFormat(v, f), 2, { passNull: true });
  def('STR_TO_DATE', (v, f) => strToDate(v, f), 2, { passNull: true });
  def('GET_FORMAT', (k, l) => getFormat(k, l), 2, { passNull: true });
  def('CONVERT_TZ', (v, a, b) => convertTz(v, a, b), 3, { passNull: true });

  /* =======================================================================
   * 4/d. JSON-függvények regisztrációja
   * ===================================================================== */

  def('JSON_EXTRACT', (v, ...paths) => jsonExtract(v, ...paths), '*', { passNull: true });
  def('JSON_UNQUOTE', v => jsonUnquote(v), 1, { passNull: true });
  def('JSON_ARRAY', (...values) => jsonArray(...values), '*', { passNull: true });
  def('JSON_OBJECT', (...pairs) => jsonObject(...pairs), '*', { passNull: true });
  def('JSON_QUOTE', v => jsonQuote(v), 1, { passNull: true });
  def('JSON_VALID', v => jsonValid(v), 1, { passNull: true });
  def('JSON_TYPE', v => jsonItemType(v), 1, { passNull: true });
  def('JSON_CONTAINS', (a, b) => jsonContains(a, b), [2, 3], { passNull: true });
  def('JSON_CONTAINS_PATH', (doc, mode, ...paths) => {
    const d = parseJson(doc);
    if (!d.ok) return null;
    const results = paths.map(p => {
      const parts = jsonPathParts(p);
      return parts && jsonWalk(d.value, parts).length ? 1 : 0;
    });
    const one = String(mode).toLowerCase() === 'one';
    return one ? (results.some(Boolean) ? 1 : 0) : (results.every(Boolean) ? 1 : 0);
  }, [3, 4, 5], { passNull: true });
  def('JSON_KEYS', v => jsonKeys(v), [1, 2], { passNull: true });
  def('JSON_LENGTH', v => jsonLength(v), [1, 2], { passNull: true });
  def('JSON_ARRAY_LENGTH', v => jsonArrayLength(v), 1, { passNull: true });
  def('JSON_DEPTH', v => {
    const d = parseJson(v);
    if (!d.ok) return null;
    const depth = node => {
      if (node === null || typeof node !== 'object') return 1;
      const values = Array.isArray(node) ? node : Object.values(node);
      return values.length ? 1 + Math.max(...values.map(depth)) : 1;
    };
    return depth(d.value);
  }, 1, { passNull: true });
  def('JSON_SET', (v, ...args) => jsonSet(v, ...args), '*', { passNull: true });
  def('JSON_INSERT', (v, ...args) => jsonInsert(v, ...args), '*', { passNull: true });
  def('JSON_REPLACE', (v, ...args) => jsonReplace(v, ...args), '*', { passNull: true });
  def('JSON_REMOVE', (v, ...paths) => jsonRemove(v, ...paths), '*', { passNull: true });
  def('JSON_SEARCH', (v, oneAll, str, esc, ...paths) => jsonSearch(v, oneAll, str, esc, ...paths), '*', { passNull: true });
  def('JSON_ARRAY_APPEND', (v, ...args) => jsonArrayAppend(v, ...args), '*', { passNull: true });
  def('JSON_ARRAY_INSERT', (v, ...args) => jsonArrayInsert(v, ...args), '*', { passNull: true });
  def('JSON_MERGE_PATCH', (a, ...rest) => jsonMergePatch(a, ...rest), '*', { passNull: true });
  /* JSON_MERGE_PRESERVE: a MySQL megőrzi az ismétlődő kulcsokat úgy, hogy
     az értékeket tömbbé alakítja ({"a":1}+{"a":2} -> {"a":[1,2]}). */
  function mergePreserveValues(a, b) {
    if (a === undefined) return b;
    if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
    if (a && b && typeof a === 'object' && typeof b === 'object' &&
      !Array.isArray(a) && !Array.isArray(b)) {
      const out = { ...a };
      for (const key of Object.keys(b)) {
        if (Object.prototype.hasOwnProperty.call(out, key)) {
          const prev = out[key];
          if (Array.isArray(prev)) out[key] = prev.concat([b[key]]);
          else out[key] = [prev, b[key]];
        } else {
          out[key] = b[key];
        }
      }
      return out;
    }
    return [a, b];
  }
  def('JSON_MERGE_PRESERVE', (a, ...rest) => {
    const items = [a, ...rest].map(parseJson);
    if (items.some(x => !x.ok)) return null;
    let merged = items[0].value;
    for (let i = 1; i < items.length; i++) merged = mergePreserveValues(merged, items[i].value);
    return dumpJson(merged);
  }, '*', { passNull: true });
  def('JSON_OVERLAPS', (a, b) => jsonOverlaps(a, b), 2, { passNull: true });
  def('JSON_PRETTY', v => {
    const d = parseJson(v);
    return d.ok ? JSON.stringify(d.value, null, 2) : null;
  }, 1, { passNull: true });
  def('JSON_STORAGE_SIZE', v => { const s = asText(v); return s === null ? null : encoder.encode(s).length; }, 1, { passNull: true });
  def('JSON_STORAGE_FREE', () => 0, 1, { passNull: true });
  def('MYSQL_JSON_TUPLE', (...values) => JSON.stringify(values), [1, 2, 3, 4, 5, 6], { passNull: true });

  /* =======================================================================
   * 5. Összesítő (aggregate) függvények
   * ---------------------------------------------------------------------
   * A SUM/AVG/MIN/MAX/COUNT/GROUP_CONCAT a beépített SQLite-aggregátumok
   * maradnak (MySQL-kompatibilisek), ezért NEM írjuk felül őket. Itt csak
   * az SQLite-ból hiányzókat készítjük el: STDDEV/VARIANCE család, BIT_*,
   * JSON_ARRAYAGG / JSON_OBJECTAGG.
   * ===================================================================== */

  /* STDDEV / VARIANCE család – Welford-módszer. */
  function varianceState() { return { n: 0, mean: 0, m2: 0 }; }
  function varianceStep(s, v) {
    if (isNull(v)) return s;
    const x = num(v);
    if (x === null) return s;
    s.n++; const delta = x - s.mean; s.mean += delta / s.n; s.m2 += delta * (x - s.mean);
    return s;
  }
  const varianceAgg = population => ({
    init: varianceState,
    step: (s, v) => varianceStep(s, v),
    finalize: s => {
      if (s.n === 0) return null;
      if (population) return s.m2 / s.n;
      return s.n > 1 ? s.m2 / (s.n - 1) : null;
    }
  });
  const stddevAgg = population => ({
    init: varianceState,
    step: (s, v) => varianceStep(s, v),
    finalize: s => {
      if (s.n === 0) return null;
      const v = population ? s.m2 / s.n : (s.n > 1 ? s.m2 / (s.n - 1) : null);
      return v === null ? null : Math.sqrt(v);
    }
  });

  const bitAgg = (op, initValue) => ({
    init: () => ({ value: initValue }),
    step: (s, v) => {
      if (isNull(v)) return s;
      const n = truncInt(v);
      if (n === null) return s;
      s.value = op(s.value, n);
      return s;
    },
    finalize: s => {
      if (s.value === null) return null;
      return s.value | 0;
    }
  });

  const jsonArrayAggState = () => ({ items: [] });
  const JSON_ARRAYAGG = {
    init: jsonArrayAggState,
    step: (s, v) => { const d = parseJson(v); s.items.push(d.ok ? d.value : v); return s; },
    finalize: s => dumpJson(s.items)
  };
  const JSON_OBJECTAGG = {
    init: () => ({ entries: [] }),
    step: (s, k, v) => {
      if (isNull(k)) return s;
      const d = parseJson(v);
      s.entries.push([asText(k), d.ok ? d.value : v]);
      return s;
    },
    finalize: s => {
      if (!s.entries.length) return null;
      const obj = {};
      for (const [k, v] of s.entries) obj[k] = v;
      return dumpJson(obj);
    }
  };

  /* =======================================================================
   * 6. Tokenizáló – közös alap az átíráshoz, az ellenőrzéshez és a kiemeléshez
   * ===================================================================== */

  const TOKEN_RE = new RegExp([
    /--(?=\s|$)[^\n]*/.source,
    /#[^\n]*/.source,
    /\/\*[\s\S]*?(?:\*\/|$)/.source,
    /[xX]'[\da-fA-F]*'/.source,
    /'(?:''|\\[\s\S]|[^'\\])*'?/.source,
    /"(?:[^"]|"")*"?/.source,
    /`(?:[^`]|``)*`?/.source,
    /\[[^\]]*\]/.source,
    /(?:[:@$][\p{L}_][\p{L}\p{N}_$]*|\?\d*)/u.source,
    /0x[\da-fA-F]+/.source,
    /(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.source,
    /[\p{L}_][\p{L}\p{N}_$]*/u.source,
    /<=>|>=|<=|<>|!=|==|\|\||<<|>>|&&/.source,
    /\s+/.source,
    /[\s\S]/.source
  ].join('|'), 'giu');

  const SQL_WORDS = new Set(('SELECT FROM WHERE HAVING GROUP ORDER BY AS ON JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL USING ' +
    'LIMIT OFFSET ASC DESC DISTINCT ALL CASE WHEN THEN ELSE END AND OR NOT IN IS LIKE BETWEEN UNION INTERSECT EXCEPT WITH ' +
    'COLLATE ESCAPE DIV MOD FOR SEPARATOR RLIKE REGEXP XOR BINARY OVER PARTITION ROWS RANGE GROUPS PRECEDING FOLLOWING ' +
    'CURRENT ROW UNBOUNDED NULLS FIRST LAST FILTER RECURSIVE EXCLUDE TIES OTHERS WINDOW QUALIFY').split(/\s+/));

  const isTrivia = text => /^\s|^--|^#|^\/\*/u.test(text);

  /* Nyers tokenek (kommentek és szóközök nélkül), pozícióval. */
  function tokenize(sql) {
    const tokens = [];
    for (const match of String(sql).matchAll(TOKEN_RE)) {
      tokens.push({
        text: match[0],
        word: match[0].toUpperCase(),
        start: match.index,
        end: match.index + match[0].length
      });
    }
    return tokens;
  }
  /* Csak a tartalmas tokenek (komment/szóköz nélkül). */
  function codeTokens(sql) {
    return tokenize(sql).filter(t => !isTrivia(t.text));
  }

  const isAtomToken = token => !!token && !SQL_WORDS.has(token.word) &&
    !/^[()[\],.;]$/.test(token.text) && !/^(?:<=>|>=|<=|<>|!=|==|\|\||<<|>>|&&|[+\-*\/%=<>!~&|^])$/.test(token.text);

  /* Párosítás: tokentől indulva a hozzá tartozó (vagy őt lezáró) zárójelet keresi. */
  function pairIndex(tokens, index, direction, opening, closing) {
    let depth = 0;
    for (let i = index; i >= 0 && i < tokens.length; i += direction) {
      if (tokens[i].word === opening) depth++;
      if (tokens[i].word === closing && --depth === 0) return i;
    }
    return -1;
  }
  /* A kifejezés kezdete: az indexen lévő token az utolsó atom-tagja. */
  function firstAtom(tokens, end) {
    const token = tokens[end];
    if (!token) return -1;
    let start = end;
    if (token.word === ')') {
      start = pairIndex(tokens, end, -1, ')', '(');
      if (start < 0) return -1;
      if (start > 0 && (isAtomToken(tokens[start - 1]) || ['LEFT', 'RIGHT', 'MOD', 'IF', 'CHAR'].includes(tokens[start - 1].word))) start--;
    } else if (token.word === 'END') {
      start = pairIndex(tokens, end, -1, 'END', 'CASE');
      if (start < 0) return -1;
    } else if (!isAtomToken(token)) return -1;
    while (tokens[start - 1] && tokens[start - 1].word === '.' && isAtomToken(tokens[start - 2])) start -= 2;
    while (tokens[start - 1] && ['-', '+', '~'].includes(tokens[start - 1].word) &&
      !isAtomToken(tokens[start - 2]) && tokens[start - 2] && tokens[start - 2].word !== ')') start--;
    return start;
  }
  /* A kifejezés vége: az indextől induló utolsó atom-tag. */
  function lastAtom(tokens, start) {
    let end = start;
    while (tokens[end] && ['-', '+', '~'].includes(tokens[end].word)) end++;
    const token = tokens[end];
    if (!token) return -1;
    if (token.word === '(') return pairIndex(tokens, end, 1, '(', ')');
    if (token.word === 'CASE') return pairIndex(tokens, end, 1, 'CASE', 'END');
    if (!isAtomToken(token) && !(tokens[end + 1] && tokens[end + 1].word === '(')) return -1;
    while (tokens[end + 1] && tokens[end + 1].word === '.' && isAtomToken(tokens[end + 2])) end += 2;
    return tokens[end + 1] && tokens[end + 1].word === '(' ? pairIndex(tokens, end + 1, 1, '(', ')') : end;
  }

  /* A legfelső szintű (zárójelbe nem zárt) tokenek. */
  function topLevelTokens(tokens) {
    let depth = 0;
    const out = [];
    for (const token of tokens) {
      if (token.word === ')') depth--;
      if (depth === 0) out.push(token);
      if (token.word === '(') depth++;
    }
    return out;
  }
  /* Vessző mentén bontás a legfelső szinten. */
  function splitTopLevel(sql, tokens, separator) {
    const parts = [];
    let start = 0;
    for (const token of topLevelTokens(tokens)) {
      if (token.word !== separator) continue;
      parts.push({ text: sql.slice(start, token.start), start, end: token.start });
      start = token.end;
    }
    parts.push({ text: sql.slice(start), start, end: sql.length });
    return parts;
  }
  /* =======================================================================
   * 7. Kifejezés-szintű átírások
   * ===================================================================== */

  const STRING_ESCAPES = { '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a', '%': '\\%', _: '\\_' };

  /* MySQL backslash-escape-elt szövegkonstans -> SQLite szövegkonstans. */
  function normalizeStringLiteral(token) {
    const inner = token.slice(1, -1);
    let value = '';
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === "'" && inner[i + 1] === "'") { value += "'"; i++; continue; }
      if (ch !== '\\') { value += ch; continue; }
      const next = inner[++i];
      if (next === undefined) { value += '\\'; break; }
      value += Object.prototype.hasOwnProperty.call(STRING_ESCAPES, next) ? STRING_ESCAPES[next] : next;
    }
    if (value.includes('\0')) {
      let hex = '';
      for (const b of encoder.encode(value)) hex += b.toString(16).padStart(2, '0');
      return "CAST(X'" + hex + "' AS TEXT)";
    }
    return "'" + value.replace(/'/g, "''") + "'";
  }

  /* Óvatos, token-alapú csere: a tokenek eredeti pozícióit használja. */
  function applyEdits(sql, edits) {
    if (!edits.length) return sql;
    edits.sort((a, b) => a.start - b.start || a.end - b.end);
    let out = '', cursor = 0;
    for (const edit of edits) {
      if (edit.start < cursor) continue;
      out += sql.slice(cursor, edit.start) + edit.text;
      cursor = edit.end;
    }
    return out + sql.slice(cursor);
  }

  /* 7.1 Alap normalizálás: kommentek, szövegkonstansok, backtick-konzisztencia. */
  function normalizeTokens(sql) {
    const edits = [];
    for (const token of tokenize(sql)) {
      if (token.text.startsWith('#')) { edits.push({ start: token.start, end: token.end, text: '-- ' + token.text.slice(1) }); continue; }
      if (token.text.startsWith('--') && sql[token.start + 2] && !/\s/.test(sql[token.start + 2])) {
        edits.push({ start: token.start, end: token.end, text: '-- ' + token.text.slice(2) });
        continue;
      }
      if (token.text[0] === "'" && token.text.includes('\\')) {
        edits.push({ start: token.start, end: token.end, text: normalizeStringLiteral(token.text) });
        continue;
      }
      if (token.text[0] === '"' && token.text.length > 1) {
        const closed = token.text.endsWith('"') && token.text.length > 2;
        const value = closed ? token.text.slice(1, -1).replace(/""/g, '"') : token.text.slice(1);
        edits.push({ start: token.start, end: token.end, text: "'" + value.replace(/'/g, "''") + "'" });
      }
    }
    return applyEdits(sql, edits);
  }

  /* 7.2 Intervallum-kifejezések: DATE_ADD(d, INTERVAL 1 DAY), d + INTERVAL 2 HOUR */
  const INTERVAL_UNITS = 'MICROSECOND|SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|QUARTER|YEAR';

  function rewriteIntervals(sql) {
    /* Függvényhívásban: MYSQL_DATE_ADD / MYSQL_DATE_SUB ( ... , INTERVAL n UNIT ) */
    for (;;) {
      const tokens = codeTokens(sql);
      let edit = null;
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!['DATE_ADD', 'ADDDATE', 'DATE_SUB', 'SUBDATE'].includes(token.word)) continue;
        if (!tokens[i + 1] || tokens[i + 1].word !== '(') continue;
        const close = pairIndex(tokens, i + 1, 1, '(', ')');
        if (close < 0) continue;
        const inner = tokens.slice(i + 2, close);
        const intervalAt = inner.findIndex(t => t.word === 'INTERVAL');
        if (intervalAt < 0) continue;
        const argSql = sql.slice(tokens[i + 1].end, tokens[close].start);
        const argTokens = inner;
        const before = argSql.slice(0, intervalAt > 0 ? argTokens[intervalAt].start - tokens[i + 1].end : 0).replace(/,\s*$/, '');
        let amountToken = argTokens[intervalAt + 1];
        let unitToken = argTokens[intervalAt + 2];
        /* INTERVAL -1 DAY: az előjel külön token, ezért hozzá kell venni. */
        if (amountToken && (amountToken.text === '-' || amountToken.text === '+')) {
          const valueToken = argTokens[intervalAt + 2];
          unitToken = argTokens[intervalAt + 3];
          if (!valueToken || !unitToken) continue;
          amountToken = { start: amountToken.start, end: valueToken.end };
        }
        if (!amountToken || !unitToken) continue;
        const amount = sql.slice(amountToken.start, amountToken.end);
        const unit = unitToken.word;
        const fn = token.word === 'DATE_SUB' || token.word === 'SUBDATE' ? 'MYSQL_DATE_SUB' : 'MYSQL_DATE_ADD';
        edit = { start: token.start, end: tokens[close].end, text: fn + '(' + before + ",'" + unit + "'," + amount + ')' };
        break;
      }
      if (!edit) break;
      sql = applyEdits(sql, [edit]);
    }

    /* Operátor alak: <kifejezés> + INTERVAL n UNIT  /  - INTERVAL n UNIT */
    for (;;) {
      const tokens = codeTokens(sql);
      let edit = null;
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].word !== 'INTERVAL') continue;
        let amountToken = tokens[i + 1];
        let unitToken = tokens[i + 2];
        /* INTERVAL -1 DAY: az előjel külön token, ezért hozzávesszük. */
        if (amountToken && (amountToken.text === '-' || amountToken.text === '+')) {
          unitToken = tokens[i + 3];
        }
        if (!amountToken || !unitToken || !new RegExp('^(?:' + INTERVAL_UNITS + ')$').test(unitToken.word)) continue;
        const signToken = tokens[i - 1];
        if (!signToken || (signToken.word !== '+' && signToken.word !== '-')) continue;
        const start = firstAtom(tokens, i - 2);
        if (start < 0) continue;
        const amountText = sql.slice(amountToken.start, unitToken.start).trim();
        /* Az összeadás és a kivonás előjele, valamint az INTERVAL saját előjele
           együtt dönti el, hogy hozzáadunk vagy kivonunk. */
        const negative = (signToken.word === '-') !== amountText.startsWith('-');
        const magnitude = amountText.replace(/^[+-]/, '');
        const fn = negative ? 'MYSQL_DATE_SUB' : 'MYSQL_DATE_ADD';
        edit = {
          start: tokens[start].start,
          end: unitToken.end,
          text: fn + '(' + sql.slice(tokens[start].start, signToken.start) + ",'" + unitToken.word + "'," + magnitude + ')'
        };
        break;
      }
      if (!edit) break;
      sql = applyEdits(sql, [edit]);
    }
    return sql;
  }

  /* 7.3 CAST / CONVERT – MySQL típusnevekkel. */
  function rewriteCast(sql) {
    const tokens = codeTokens(sql);
    const edits = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.word !== 'CAST' && token.word !== 'CONVERT') continue;
      if (!tokens[i + 1] || tokens[i + 1].word !== '(') continue;
      const close = pairIndex(tokens, i + 1, 1, '(', ')');
      if (close < 0) continue;
      const end = tokens[i + 1].end;
      const body = sql.slice(end, tokens[close].start);
      const bodyTokens = tokens.slice(i + 2, close);
      if (bodyTokens.length < 2) continue;

      /* CONVERT(x, type) — a típus lehet DECIMAL(10,1) is. */
      if (token.word === 'CONVERT') {
        let depth = 0, commaAt = -1;
        for (let k = 0; k < bodyTokens.length; k++) {
          const t = bodyTokens[k];
          if (t.word === '(') depth++;
          else if (t.word === ')') depth--;
          else if (t.text === ',' && depth === 0) { commaAt = k; break; }
        }
        if (commaAt > 0) {
          const typeToken = bodyTokens[commaAt + 1];
          const type = typeToken ? convertType(typeToken.word) : null;
          if (type) {
            const valueSql = sql.slice(tokens[i + 2].start, bodyTokens[commaAt].start).trim();
            const typeSql = sql.slice(bodyTokens[commaAt].start, tokens[close].start).trim();
            /* CONVERT(x, DECIMAL(p,s)) is a megadott tizedesjegyre kerekít. */
            if (typeToken && /^(?:DECIMAL|NUMERIC|DEC|FIXED)$/.test(typeToken.word)) {
              const scaleMatch = /^[\w]+\s*\(\s*\d+\s*(?:,\s*(\d+)\s*)?\)/i.exec(typeSql);
              const scale = scaleMatch && scaleMatch[1] !== undefined ? scaleMatch[1] : '0';
              edits.push({ start: token.start, end: tokens[close].end, text: 'MYSQL_CAST_DECIMAL(' + valueSql + ', ' + scale + ')' });
              continue;
            }
            edits.push({ start: token.start, end: tokens[close].end, text: 'CAST(' + valueSql + ' AS ' + type + ')' });
            continue;
          }
        }
      }
      /* CONVERT(x USING charset) */
      const usingAt = bodyTokens.findIndex(t => t.word === 'USING');
      if (usingAt >= 0) {
        edits.push({ start: token.start, end: tokens[close].end, text: '(' + sql.slice(tokens[i + 2].start, bodyTokens[usingAt].start).trim() + ')' });
        continue;
      }
      /* CAST(x AS type) */
      const asAt = bodyTokens.findIndex(t => t.word === 'AS');
      if (asAt < 0) continue;
      const valueSql = sql.slice(tokens[i + 2].start, bodyTokens[asAt].start).trim();
      const typeTokens = bodyTokens.slice(asAt + 1);
      const typeWord = typeTokens[0] ? typeTokens[0].word : '';
      const typeSql = sql.slice(bodyTokens[asAt].end, tokens[close].start).trim();
      if (/^DATE$/.test(typeWord)) { edits.push({ start: token.start, end: tokens[close].end, text: 'MYSQL_DATE(' + valueSql + ')' }); continue; }
      if (/^DATETIME$|^TIMESTAMP$/.test(typeWord)) { edits.push({ start: token.start, end: tokens[close].end, text: 'MYSQL_TIMESTAMP(' + valueSql + ')' }); continue; }
      if (/^TIME$/.test(typeWord)) { edits.push({ start: token.start, end: tokens[close].end, text: 'MYSQL_TIME(' + valueSql + ')' }); continue; }
      /* CAST(x AS CHAR[(n)]) — MySQL egész számnál nem ír .0-t, a hosszat levágja. */
      if (/^(?:N?CHAR|CHARACTER|NCHAR)$/.test(typeWord)) {
        const lenMatch = /^[\w]+\s*\(\s*(\d+)\s*\)/i.exec(typeSql);
        edits.push({
          start: token.start, end: tokens[close].end,
          text: 'MYSQL_CAST_CHAR(' + valueSql + (lenMatch ? ', ' + lenMatch[1] : '') + ')'
        });
        continue;
      }
      const mapped = convertType(typeWord);
      /* CAST(x AS DECIMAL(p,s)) / NUMERIC: MySQL a megadott tizedesjegyre
         kerekít, az SQLite NUMERIC típusa nem tenné. */
      if (/^(?:DECIMAL|NUMERIC|DEC|FIXED)$/.test(typeWord)) {
        const scaleMatch = /^[\w]+\s*\(\s*\d+\s*(?:,\s*(\d+)\s*)?\)/i.exec(typeSql);
        const scale = scaleMatch && scaleMatch[1] !== undefined ? scaleMatch[1] : '0';
        edits.push({ start: token.start, end: tokens[close].end, text: 'MYSQL_CAST_DECIMAL(' + valueSql + ', ' + scale + ')' });
        continue;
      }
      if (mapped) edits.push({ start: token.start, end: tokens[close].end, text: 'CAST(' + valueSql + ' AS ' + mapped + ')' });
      else {
        /* Ismeretlen típus: DECIMAL/NUMERIC -> NUMERIC, egyébként TEXT. */
        const fallback = /DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL/i.test(typeSql) ? 'NUMERIC' : 'TEXT';
        edits.push({ start: token.start, end: tokens[close].end, text: 'CAST(' + valueSql + ' AS ' + fallback + ')' });
      }
    }
    return applyEdits(sql, edits);
  }
  function convertType(word) {
    switch (word) {
      case 'SIGNED': case 'UNSIGNED': case 'INTEGER': case 'INT':
        return 'INTEGER';
      case 'CHAR': case 'NCHAR': case 'VARCHAR': case 'TEXT': case 'TINYTEXT': case 'MEDIUMTEXT': case 'LONGTEXT':
        return 'TEXT';
      case 'DECIMAL': case 'NUMERIC': case 'FLOAT': case 'DOUBLE': case 'REAL':
        return 'NUMERIC';
      case 'BINARY': case 'VARBINARY':
        /* A tananyagban a CAST(x AS BINARY) szöveget ad (a bájt-tömb
           megjelenítése zavaró lenne az eredménytáblázatban). */
        return 'TEXT';
      case 'BLOB':
        return 'BLOB';
      case 'JSON':
        return 'TEXT';
      case 'BOOLEAN': case 'BOOL':
        return 'INTEGER';
      default:
        return null;
    }
  }

  /* 7.4 TRIM(LEADING 'x' FROM y) */
  function rewriteTrim(sql) {
    const tokens = codeTokens(sql);
    const edits = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].word !== 'TRIM') continue;
      if (!tokens[i + 1] || tokens[i + 1].word !== '(') continue;
      const close = pairIndex(tokens, i + 1, 1, '(', ')');
      if (close < 0) continue;
      const inner = tokens.slice(i + 2, close);
      const fromAt = inner.findIndex(t => t.word === 'FROM');
      if (fromAt < 0) continue;
      const direction = ['LEADING', 'TRAILING', 'BOTH'].includes(inner[0] && inner[0].word) ? inner[0].word : 'BOTH';
      const skip = direction === 'BOTH' && inner[0] && inner[0].word === 'BOTH' ? 1 : (['LEADING', 'TRAILING', 'BOTH'].includes(inner[0] && inner[0].word) ? 1 : 0);
      const removableStart = inner[skip] ? inner[skip].start : tokens[i + 1].end;
      const removableRaw = sql.slice(removableStart, inner[fromAt].start).trim();
      /* TRIM(LEADING FROM x) — a kivágandó alapból szóköz. */
      const removable = removableRaw || "' '";
      const source = sql.slice(inner[fromAt].end, tokens[close].start).trim();
      edits.push({ start: tokens[i].start, end: tokens[close].end, text: "MYSQL_TRIM_DIR(" + source + ',' + removable + ",'" + direction + "')" });
    }
    return applyEdits(sql, edits);
  }

  /* 7.5 GROUP_CONCAT: SEPARATOR, ORDER BY és többargumentumos alak.
     Az SQLite beépített group_concat-je 1 és 2 argumentummal MySQL-kompatibilis
     (NULL-t ad üres csoportra, DISTINCT-et és ORDER BY-t is ismer), ezért azt
     használjuk; csak a többargumentumos és a DISTINCT+SEPARATOR esetet kell
     átalakítani. */
  function rewriteGroupConcat(sql) {
    const tokens = codeTokens(sql);
    const edits = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].word !== 'GROUP_CONCAT') continue;
      if (!tokens[i + 1] || tokens[i + 1].word !== '(') continue;
      const close = pairIndex(tokens, i + 1, 1, '(', ')');
      if (close < 0) continue;
      const inner = tokens.slice(i + 2, close);
      const distinct = inner[0] && inner[0].word === 'DISTINCT';
      const sepAt = inner.findIndex(t => t.word === 'SEPARATOR');
      const orderAt = inner.findIndex((t, k) => t.word === 'ORDER' && inner[k + 1] && inner[k + 1].word === 'BY');
      const argsStart = distinct ? inner[0].end : tokens[i + 1].end;
      const argsEndToken = orderAt >= 0 ? inner[orderAt] : (sepAt >= 0 ? inner[sepAt] : null);
      const argsEnd = argsEndToken ? argsEndToken.start : tokens[close].start;
      const argsSql = sql.slice(argsStart, argsEnd).trim();
      const args = argsSql ? splitTopLevel(argsSql, codeTokens(argsSql), ',') : [];
      if (!args.length) continue;
      const separatorSql = sepAt >= 0 ? sql.slice(inner[sepAt].end, orderAt >= 0 && orderAt > sepAt ? inner[orderAt].start : tokens[close].start).trim() : "','";
      const orderSql = orderAt >= 0 ? sql.slice(inner[orderAt].start, sepAt >= 0 && sepAt > orderAt ? inner[sepAt].start : tokens[close].start).trim() : '';
      const orderPart = orderSql ? ' ' + orderSql : '';
      const hasExplicitSeparator = sepAt >= 0;

      /* Többargumentumos: a soron belüli értékeket összefűzzük (MySQL: NULL -> kimarad). */
      const valueSql = args.length === 1 ? args[0].text.trim() : 'MYSQL_CONCAT_ROW(' + args.map(a => a.text.trim()).join(',') + ')';

      /* A kimenet MINDIG egyargumentumos group_concat marad, így az átírás
         többször is lefuttatható (idempotens). Egyedi elválasztó esetén az
         értékeket kódoljuk, hogy a bennük lévő vessző ne törje meg a JOIN-t. */
      const alreadyEncoded = /^MYSQL_GC_ENCODE\(/i.test(valueSql);
      if (!hasExplicitSeparator) {
        edits.push({
          start: tokens[i].start, end: tokens[close].end,
          text: 'group_concat(' + (distinct ? 'distinct ' : '') + valueSql + orderPart + ')'
        });
        continue;
      }
      edits.push({
        start: tokens[i].start, end: tokens[close].end,
        text: 'MYSQL_GC_JOIN(group_concat(' + (distinct ? 'distinct ' : '') +
          (alreadyEncoded ? valueSql : 'MYSQL_GC_ENCODE(' + valueSql + ')') + orderPart + '),' + separatorSql + ')'
      });
    }
    return applyEdits(sql, edits);
  }

  /* 7.6 Aritmetika: /, DIV, MOD, % – MySQL szemantika. */
  /* GET_FORMAT(DATE|DATETIME|TIME, 'EUR') -> konkrét formátumszöveg. */
  const GET_FORMAT_TABLE = {
    DATE: {
      USA: '%m.%d.%Y', JIS: '%Y-%m-%d', ISO: '%Y-%m-%d', EUR: '%d.%m.%Y', INTERNAL: '%Y%m%d'
    },
    DATETIME: {
      USA: '%Y-%m-%d %H.%i.%s', JIS: '%Y-%m-%d %H:%i:%s', ISO: '%Y-%m-%d %H:%i:%s',
      EUR: '%Y-%m-%d %H.%i.%s', INTERNAL: '%Y%m%d%H%i%s'
    },
    TIME: {
      USA: '%h:%i:%s %p', JIS: '%H:%i:%s', ISO: '%H:%i:%s', EUR: '%H.%i.%s', INTERNAL: '%H%i%s'
    }
  };

  function rewriteGetFormat(sql) {
    if (!/GET_FORMAT\s*\(/i.test(sql)) return sql;
    const tokens = codeTokens(sql);
    const edits = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].word !== 'GET_FORMAT') continue;
      if (!tokens[i + 1] || tokens[i + 1].word !== '(') continue;
      const close = pairIndex(tokens, i + 1, 1, '(', ')');
      if (close < 0) continue;
      const inner = sql.slice(tokens[i + 1].end, tokens[close].start);
      const parts = splitTopLevel(inner, codeTokens(inner), ',');
      if (parts.length !== 2) continue;
      const kind = parts[0].text.trim().toUpperCase().replace(/^['"]|['"]$/g, '');
      const style = parts[1].text.trim().toUpperCase().replace(/^['"]|['"]$/g, '');
      const table = GET_FORMAT_TABLE[kind];
      const value = table && table[style];
      edits.push({ start: tokens[i].start, end: tokens[close].end, text: value ? "'" + value + "'" : 'NULL' });
    }
    return applyEdits(sql, edits);
  }

  /* 7.6 Aritmetikai operátorok (/, DIV, MOD, ^, XOR) függvényhívásra. */
  function rewriteArithmetic(sql) {
    const arithmetic = new Map([
      ['/', 'MYSQL_REAL_DIV'], ['DIV', 'MYSQL_DIV'], ['MOD', 'MYSQL_MOD'],
      ['^', 'MYSQL_BIT_XOR'], ['XOR', 'MYSQL_XOR']
    ]);
    for (;;) {
      const tokens = codeTokens(sql);
      let edit = null;
      for (let i = 1; i < tokens.length - 1; i++) {
        const name = arithmetic.get(tokens[i].word);
        if (!name) continue;
        const start = firstAtom(tokens, i - 1);
        const end = lastAtom(tokens, i + 1);
        if (start < 0 || end < 0) continue;
        if (tokens[start - 1] && tokens[start - 1].word === '.') continue;
        let from = start;
        while (tokens[from - 1] && tokens[from - 1].word === '*') {
          const previous = firstAtom(tokens, from - 2);
          if (previous < 0) break;
          from = previous;
        }
        edit = {
          start: tokens[from].start, end: tokens[end].end,
          text: name + '(' + sql.slice(tokens[from].start, tokens[i - 1].end) + ',' + sql.slice(tokens[i + 1].start, tokens[end].end) + ')'
        };
        break;
      }
      if (!edit) break;
      sql = applyEdits(sql, [edit]);
    }
    return sql;
  }

  /* 7.7 Apró szintaktikai cserék: ISNULL(), <=>, VALUES(), LIMIT a,b. */
  function rewriteSmallSyntax(sql) {
    const tokens = codeTokens(sql);
    const edits = [];

    /* Az SQLite ezeket beépített kulcsszóként ismeri, és NEM fogad
       zárójelet: CURRENT_TIMESTAMP(), CURRENT_DATE(), CURRENT_TIME().
       A MySQL viszont mindkét alakot engedi, ezért a zárójelet eldobjuk. */
    const KEYWORD_NO_PARENS = new Set(['CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME']);
    /* Ezek az SQLite-ban nincsenek kulcsszóként, csak függvényként;
       a MySQL viszont zárójel nélkül is használja őket. */
    const KEYWORD_NEEDS_PARENS = new Set(['LOCALTIME', 'LOCALTIMESTAMP', 'SYSDATE', 'CURRENT_USER', 'SESSION_USER', 'SYSTEM_USER']);

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const prev = tokens[i - 1];
      const isQualified = prev && prev.word === '.';
      const noParens = tokens[i + 1] && tokens[i + 1].word === '(';
      /* Törtmásodperc-pontosság a zárójelben: csak eldobjuk. */
      if (KEYWORD_NO_PARENS.has(token.word) && !isQualified && noParens) {
        const close = pairIndex(tokens, i + 1, 1, '(', ')');
        /* Üres zárójel: CURRENT_TIMESTAMP()  vagy  pontosság: CURRENT_TIMESTAMP(3) */
        const empty = close > 0 && close === i + 2;
        const precision = close > 0 && close === i + 3 && /^\d+$/.test(tokens[i + 2].text);
        if (empty || precision) {
          edits.push({ start: tokens[i + 1].start, end: tokens[close].end, text: '' });
        }
        continue;
      }
      /* Zárójel nélküli használat -> üres zárójel. */
      if (KEYWORD_NEEDS_PARENS.has(token.word) && !isQualified && !noParens) {
        if (prev && prev.word === '(') continue;
        edits.push({ start: token.end, end: token.end, text: '()' });
        continue;
      }
      /* ISNULL(x) -> (x IS NULL) */
      if (token.word === 'ISNULL' && tokens[i + 1] && tokens[i + 1].word === '(') {
        const close = pairIndex(tokens, i + 1, 1, '(', ')');
        if (close > 0) {
          edits.push({ start: token.start, end: tokens[close].end, text: '(' + sql.slice(tokens[i + 1].end, tokens[close].start) + ' IS NULL)' });
        }
        continue;
      }
      /* <=> null-biztos egyenlőség -> IS */
      if (token.text === '<=>') edits.push({ start: token.start, end: token.end, text: ' IS ' });
      /* RLIKE -> REGEXP (az SQLite operátora REGEXP). */
      if (token.word === 'RLIKE') edits.push({ start: token.start, end: token.end, text: 'REGEXP' });
      /* MySQL !kifejezés -> NOT kifejezés (az SQLite nem ismeri a ! operátort). */
      if (token.text === '!') edits.push({ start: token.start, end: token.end, text: ' NOT ' });
      /* POSITION(x IN y) -> MYSQL_LOCATE(x, y) */
      if (token.word === 'POSITION' && tokens[i + 1] && tokens[i + 1].word === '(') {
        const close = pairIndex(tokens, i + 1, 1, '(', ')');
        if (close > 0) {
          const inner = sql.slice(tokens[i + 1].end, tokens[close].start);
          const parts = splitTopLevel(inner, codeTokens(inner), 'IN');
          if (parts.length === 2) {
            edits.push({ start: token.start, end: tokens[close].end, text: 'MYSQL_LOCATE(' + parts[0].text.trim() + ',' + parts[1].text.trim() + ')' });
          }
        }
        continue;
      }
      /* TIMESTAMPDIFF(unit, a, b): az egység azonosító, ezért idézőjelbe tesszük. */
      if ((token.word === 'TIMESTAMPDIFF' || token.word === 'TIMESTAMPADD') &&
        tokens[i + 1] && tokens[i + 1].word === '(') {
        const close = pairIndex(tokens, i + 1, 1, '(', ')');
        if (close > 0) {
          const innerSql = sql.slice(tokens[i + 1].end, tokens[close].start);
          const parts = splitTopLevel(innerSql, codeTokens(innerSql), ',');
          if (parts.length === 3 && /^[A-Z]+$/i.test(parts[0].text.trim())) {
            parts[0] = { text: "'" + parts[0].text.trim().toUpperCase() + "'" };
            edits.push({ start: token.start, end: tokens[close].end, text: token.word + '(' + parts.map(p => p.text.trim()).join(',') + ')' });
          }
        }
        continue;
      }
      /* EXTRACT(unit FROM x) -> MYSQL_EXTRACT('unit', x) */
      if (token.word === 'EXTRACT' && tokens[i + 1] && tokens[i + 1].word === '(') {
        const close = pairIndex(tokens, i + 1, 1, '(', ')');
        if (close > 0) {
          const innerSql = sql.slice(tokens[i + 1].end, tokens[close].start);
          const parts = splitTopLevel(innerSql, codeTokens(innerSql), 'FROM');
          if (parts.length === 2) {
            edits.push({ start: token.start, end: tokens[close].end, text: "MYSQL_EXTRACT('" + parts[0].text.trim().toUpperCase() + "'," + parts[1].text.trim() + ')' });
          }
        }
        continue;
      }
    }

    /* LIMIT n, m -> LIMIT m OFFSET n */
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].word !== 'LIMIT') continue;
      const a = tokens[i + 1], comma = tokens[i + 2], b = tokens[i + 3];
      if (!a || !comma || !b || comma.word !== ',') continue;
      if (!/^\d+$/.test(a.text) || !/^\d+$/.test(b.text)) continue;
      /* Egyetlen cserével, hogy a két rész ne csússzon el egymáson. */
      edits.push({ start: a.start, end: b.end, text: b.text + ' OFFSET ' + a.text });
    }
    return applyEdits(sql, edits);
  }

  /* 7.8/b UPDATE/DELETE ... ORDER BY ... LIMIT – az SQLite nem ismeri.
     Átalakítás: WHERE rowid IN (SELECT rowid FROM ... ORDER BY ... LIMIT ...) */
  function rewriteRowLimit(sql) {
    const tokens = codeTokens(sql);
    if (!tokens.length) return sql;
    const head = tokens[0].word;
    if (head !== 'UPDATE' && head !== 'DELETE') return sql;

    const top = topLevelTokens(tokens);
    const limitToken = top.find(t => t.word === 'LIMIT');
    if (!limitToken) return sql;
    const limitPosition = tokens.indexOf(limitToken);

    /* Többtáblás alakot (vessző a SET/WHERE előtt) nem bontjuk. */
    const firstComma = top.find(t => t.text === ',');
    if (firstComma && tokens.indexOf(firstComma) < limitPosition &&
      !(top.some(t => t.word === 'SET') && tokens.indexOf(firstComma) > tokens.indexOf(top.find(t => t.word === 'SET')))) {
      return sql;
    }

    let cursor = 1;
    if (head === 'DELETE') {
      while (tokens[cursor] && ['LOW_PRIORITY', 'QUICK', 'IGNORE', 'FROM'].includes(tokens[cursor].word)) cursor++;
    } else {
      while (tokens[cursor] && ['LOW_PRIORITY', 'IGNORE'].includes(tokens[cursor].word)) cursor++;
    }
    const tableStart = cursor;
    if (!tokens[tableStart] || !isAtomToken(tokens[tableStart])) return sql;
    let tableEnd = tableStart;
    while (tokens[tableEnd + 1] && tokens[tableEnd + 1].word === '.' && isAtomToken(tokens[tableEnd + 2])) tableEnd += 2;
    const tableRef = sql.slice(tokens[tableStart].start, tokens[tableEnd].end);

    let alias = null;
    let after = tableEnd + 1;
    if (tokens[after] && tokens[after].word === 'AS' && tokens[after + 1] && isAtomToken(tokens[after + 1])) {
      alias = sql.slice(tokens[after + 1].start, tokens[after + 1].end);
      after += 2;
    } else if (tokens[after] && isAtomToken(tokens[after]) &&
      !['SET', 'WHERE', 'ORDER', 'LIMIT'].includes(tokens[after].word)) {
      alias = sql.slice(tokens[after].start, tokens[after].end);
      after += 1;
    }
    const aliasSql = alias ? ' AS ' + alias : '';

    /* SELECT-listák elejének és a WHERE/ORDER BY részek kiemelése. */
    const setIndex = top.find(t => t.word === 'SET');
    const whereToken = top.find(t => t.word === 'WHERE');
    const orderToken = top.find(t => t.word === 'ORDER');
    const wherePosition = whereToken ? tokens.indexOf(whereToken) : -1;
    const orderPosition = orderToken ? tokens.indexOf(orderToken) : -1;

    let whereSql = '', orderSql = '';
    if (wherePosition >= 0) {
      const end = orderPosition >= 0 ? orderPosition : limitPosition;
      whereSql = ' ' + sql.slice(tokens[wherePosition].start, tokens[end].start).trim();
    }
    if (orderPosition >= 0) {
      orderSql = ' ' + sql.slice(tokens[orderPosition].start, tokens[limitPosition].start).trim();
    }
    const limitSql = ' ' + sql.slice(tokens[limitPosition].start).trim();
    const subquery = '(SELECT rowid FROM ' + tableRef + aliasSql + whereSql + orderSql + limitSql + ')';

    if (head === 'UPDATE') {
      if (!setIndex) return sql;
      const setPosition = tokens.indexOf(setIndex);
      const setPart = sql.slice(tokens[setPosition].start, wherePosition >= 0 ? tokens[wherePosition].start : (orderPosition >= 0 ? tokens[orderPosition].start : tokens[limitPosition].start)).trim().replace(/,?\s*$/, '');
      const tail = sql.slice(tableEnd + 1, tokens[setPosition].start).trim();
      return 'UPDATE ' + tableRef + aliasSql + ' ' + setPart + ' WHERE rowid IN ' + subquery;
    }
    return 'DELETE FROM ' + tableRef + aliasSql + ' WHERE rowid IN ' + subquery;
  }

  /* 7.8/c INSERT ... SET és ON DUPLICATE KEY UPDATE. */
  /* INSERT INTO t () VALUES () / VALUES () -> DEFAULT VALUES. */
  function emptyInsertEdits(sql, tokens) {
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].word !== 'INTO') continue;
      /* ... t () VALUES () */
      let j = i + 1;
      while (tokens[j] && isAtomToken(tokens[j])) j++;
      if (!(tokens[j] && tokens[j].word === '(' && tokens[j + 1] && tokens[j + 1].word === ')')) continue;
      if (!(tokens[j - 1] && isAtomToken(tokens[j - 1]))) continue;
      const valuesAt = j + 2;
      if (!(tokens[valuesAt] && ['VALUES', 'VALUE'].includes(tokens[valuesAt].word))) continue;
      const openV = valuesAt + 1;
      if (!(tokens[openV] && tokens[openV].word === '(' && tokens[openV + 1] && tokens[openV + 1].word === ')')) continue;
      out.push({ start: tokens[j].start, end: tokens[openV + 1].end, text: 'DEFAULT VALUES' });
      i = openV + 1;
    }
    /* VALUES () önmagában (INSERT ... t VALUES ()) */
    for (let i = 0; i < tokens.length; i++) {
      if (!['VALUES', 'VALUE'].includes(tokens[i].word)) continue;
      if (!(tokens[i + 1] && tokens[i + 1].word === '(' && tokens[i + 2] && tokens[i + 2].word === ')')) continue;
      if (out.some(e => i + 1 >= 0 && tokens[i + 1].start >= e.start && tokens[i + 1].start < e.end)) continue;
      out.push({ start: tokens[i].start, end: tokens[i + 2].end, text: 'DEFAULT VALUES' });
      i += 2;
    }
    return out;
  }

  function rewriteInsert(sql) {
    const tokens = codeTokens(sql);
    if (!tokens.length) return sql;
    const edits = [];

    /* INSERT IGNORE INTO -> INSERT OR IGNORE INTO (az SQLite alakja). */
    if (tokens[0] && tokens[0].word === 'INSERT') {
      let k = 1;
      while (tokens[k] && ['LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY'].includes(tokens[k].word)) k++;
      if (tokens[k] && tokens[k].word === 'IGNORE') {
        edits.push({ start: tokens[0].start, end: tokens[k].end, text: 'INSERT OR IGNORE' });
      }
    }
    /* INSERT INTO t () VALUES () -> INSERT INTO t DEFAULT VALUES */
    edits.push(...emptyInsertEdits(sql, tokens));

    /* INSERT INTO t SET a=1, b=2 -> INSERT INTO t (a,b) VALUES (1,2) */
    const insertAt = tokens.findIndex(t => ['INSERT', 'REPLACE'].includes(t.word));
    if (insertAt >= 0) {
      let k = insertAt + 1;
      while (tokens[k] && ['LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY', 'IGNORE', 'INTO'].includes(tokens[k].word)) k++;
      /* tábla neve, esetleg backtickes, ponttal */
      let tableEnd = k;
      if (isAtomToken(tokens[k])) {
        tableEnd = k;
        while (tokens[tableEnd + 1] && tokens[tableEnd + 1].word === '.' && isAtomToken(tokens[tableEnd + 2])) tableEnd += 2;
      }
      if (tokens[tableEnd + 1] && tokens[tableEnd + 1].word === 'SET') {
        const setStart = tokens[tableEnd + 1].end;
        const rest = sql.slice(setStart);
        const restTokens = codeTokens(rest);
        const parts = splitTopLevel(rest, restTokens, ',');
        const columns = [], values = [];
        for (const part of parts) {
          const eq = codeTokens(part.text).findIndex(t => t.text === '=');
          if (eq < 0) return sql;
          const eqToken = codeTokens(part.text)[eq];
          columns.push(part.text.slice(0, eqToken.start).trim());
          values.push(part.text.slice(eqToken.end).trim());
        }
        edits.push({
          start: tokens[tableEnd + 1].start, end: sql.length,
          text: '(' + columns.join(',') + ') VALUES (' + values.join(',') + ')'
        });
      }
    }

    /* ON DUPLICATE KEY UPDATE -> ON CONFLICT DO UPDATE SET
       A VALUES(oszlop) hivatkozást itt cseréljük excluded.oszlop-ra. */
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].word === 'ON' && tokens[i + 1] && tokens[i + 1].word === 'DUPLICATE' &&
        tokens[i + 2] && tokens[i + 2].word === 'KEY' && tokens[i + 3] && tokens[i + 3].word === 'UPDATE') {
        const tail = sql.slice(tokens[i + 3].end);
        const values = tail.replace(/\bVALUES\s*\(\s*(`?[\w$]+`?)\s*\)/gi, (m, name) => 'excluded.' + unquoteName(name));
        edits.push({ start: tokens[i].start, end: sql.length, text: 'ON CONFLICT DO UPDATE SET' + values });
      }
    }
    return applyEdits(sql, edits);
  }

  /* GROUP BY ... WITH ROLLUP: az SQLite nem ismeri. Egyszerű esetben a
     csoportosított lekérdezést kiegészítjük egy összesítő sorral. */
  function rewriteRollup(sql) {
    if (!/\bWITH\s+ROLLUP\b/i.test(sql)) return sql;
    const clean = sql.replace(/\s+WITH\s+ROLLUP\s*/i, ' ');
    const tokens = codeTokens(clean);
    const fromAt = tokens.findIndex(t => t.word === 'FROM');
    const groupAt = tokens.findIndex(t => t.word === 'GROUP');
    if (fromAt < 0 || groupAt < 0 || groupAt < fromAt) return clean;
    /* ORDER BY / LIMIT a GROUP BY után: a teljes unió végére kerül. */
    let tailAt = -1;
    for (let i = groupAt + 1; i < tokens.length; i++) {
      if (['ORDER', 'LIMIT'].includes(tokens[i].word)) { tailAt = i; break; }
    }
    const selectList = clean.slice(tokens[1] ? tokens[1].start : 0, tokens[fromAt].start).trim();
    const fromBody = clean.slice(tokens[fromAt].start, tailAt >= 0 ? tokens[tailAt].start : clean.length).trim();
    const tail = tailAt >= 0 ? clean.slice(tokens[tailAt].start).trim() : '';
    /* Csoportkifejezések begyűjtése. */
    const groupEnd = tailAt >= 0 ? tokens[tailAt].start : clean.length;
    const groupSql = clean.slice(tokens[groupAt].end, groupEnd).replace(/^\s*BY\b/i, '').trim();
    const groupParts = splitTopLevel(groupSql, codeTokens(groupSql), ',')
      .map(p => p.text.trim().replace(/\s+/g, ' ').toLowerCase()).filter(Boolean);
    const items = splitTopLevel(selectList, codeTokens(selectList), ',');
    const totalItems = items.map(item => {
      const normalized = item.text.trim().replace(/\s+/g, ' ').toLowerCase();
      return groupParts.includes(normalized) ? 'NULL' : item.text.trim();
    });
    return 'SELECT ' + selectList + ' ' + fromBody +
      ' UNION ALL SELECT ' + totalItems.join(', ') + ' ' +
      fromBody.replace(/\bGROUP\s+BY\b[\s\S]*$/i, '').trim() + (tail ? ' ' + tail : '');
  }

  /* SELECT ... INTO @valtozo: az SQLite nem ismeri, a INTO záradékot kivágjuk. */
  function rewriteSelectInto(sql) {
    if (!/^\s*SELECT\b/i.test(sql) || !/\bINTO\s+@/i.test(sql)) return sql;
    return sql.replace(/\s+INTO\s+@[\w$]+(?:\s*,\s*@[\w$]+)*/i, ' ');
  }

  /* 7.9 Függvénynevek, amelyeket át kell írni (SQLite eltérő szemantikája miatt). */
  const RENAME_FUNCTIONS = {
    LENGTH: 'MYSQL_OCTET_LENGTH',
    FORMAT: 'MYSQL_FORMAT',
    CONCAT: 'MYSQL_CONCAT',
    CONCAT_WS: 'MYSQL_CONCAT_WS',
    IF: 'MYSQL_IF',
    GREATEST: 'MYSQL_GREATEST',
    LEAST: 'MYSQL_LEAST',
    ROUND: 'MYSQL_ROUND',
    CHAR: 'MYSQL_CHAR',
    FIND_IN_SET: 'MYSQL_FIND_IN_SET',
    INSERT: 'MYSQL_INSERT'
  };
  /* Csak akkor írjuk át, ha az SQLite beépítettje másképp viselkedne. */
  const CONDITIONAL_RENAMES = new Set(['ROUND', 'FORMAT', 'CHAR', 'IF', 'GREATEST', 'LEAST', 'INSERT']);

  function rewriteFunctionNames(sql) {
    const tokens = codeTokens(sql);
    const edits = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const target = RENAME_FUNCTIONS[token.word];
      if (!target) continue;
      if (!tokens[i + 1] || tokens[i + 1].word !== '(') continue;
      if (tokens[i - 1] && tokens[i - 1].word === '.') continue;
      if (CONDITIONAL_RENAMES.has(token.word)) {
        const close = pairIndex(tokens, i + 1, 1, '(', ')');
        if (close < 0) continue;
        const args = splitTopLevel(sql.slice(tokens[i + 1].end, tokens[close].start), tokens.slice(i + 2, close), ',');
        if (token.word === 'ROUND' && args.length < 2) continue;
        if (token.word === 'FORMAT' && args.length < 2) continue;
        if (token.word === 'CHAR' && args.length < 1) continue;
        if (token.word === 'INSERT' && args.length !== 4) continue;
        if ((token.word === 'IF' || token.word === 'GREATEST' || token.word === 'LEAST') && args.length < 2) continue;
      }
      edits.push({ start: token.start, end: token.end, text: target });
    }
    return applyEdits(sql, edits);
  }

  /* 7.10 BINARY operátor, COLLATE, charset-toldalékok eltávolítása. */
  function rewriteModifiers(sql) {
    const tokens = codeTokens(sql);
    const edits = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.word === 'BINARY' && tokens[i + 1] && isAtomToken(tokens[i + 1])) {
        edits.push({ start: token.start, end: tokens[i + 1].start, text: '' });
        continue;
      }
      if (token.word === 'COLLATE' && tokens[i + 1]) {
        edits.push({ start: token.start, end: tokens[i + 1].end, text: '' });
        continue;
      }
      if (token.word === 'COLLATE' ) continue;
    }
    /* COLLATE utf8mb4_hungarian_ci stb. – a COLLATE kulcsszó utáni azonosító */
    let out = applyEdits(sql, edits);
    out = out.replace(/\bCOLLATE\s+`?[\w$]+`?/gi, '');
    return out;
  }

  /* MySQL-ben a HAVING összesítés és GROUP BY nélkül is megengedett: a SELECT
     után fut le, ezért a SELECT-álneveket is ismeri. Az SQLite ilyenkor
     „HAVING clause on a non-aggregate query” hibát dob, ezért a HAVING-et
     WHERE-re alakítjuk, és az álneveket a mögöttes kifejezésre cseréljük. */
  function rewriteLooseHaving(sql) {
    const source = String(sql == null ? '' : sql);
    if (!/\bHAVING\b/i.test(source)) return source;
    const tokens = codeTokens(source);
    if (!tokens.length || tokens[0].word !== 'SELECT') return source;

    /* Zárójelmélység tokenenként: csak a legfelső szint számít. */
    const depths = [];
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].word === ')') depth = Math.max(0, depth - 1);
      depths.push(depth);
      if (tokens[i].word === '(') depth++;
    }

    const havingIdx = tokens.findIndex((t, i) => t.word === 'HAVING' && depths[i] === 0);
    if (havingIdx < 0) return source;
    /* Csoportosított lekérdezést és összetett (UNION) lekérdezést az SQLite is
       kezel, illetve túl kockázatos átírni — ezeket érintetlenül hagyjuk. */
    for (let i = 0; i < tokens.length; i++) {
      if (depths[i] !== 0) continue;
      if (['UNION', 'INTERSECT', 'EXCEPT'].includes(tokens[i].word)) return source;
      if (tokens[i].word === 'GROUP' && tokens[i + 1] && tokens[i + 1].word === 'BY') return source;
    }
    /* Összesítő függvény jelenlétében az SQLite saját maga is lefuttatja. */
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i + 1] && tokens[i + 1].word === '(' && isAggregateWord(tokens[i].word)) return source;
    }

    const stopWords = new Set(['ORDER', 'LIMIT', 'WINDOW', 'UNION', 'INTERSECT', 'EXCEPT', 'PROCEDURE', 'INTO']);
    let endIdx = tokens.length;
    for (let i = havingIdx + 1; i < tokens.length; i++) {
      if (depths[i] !== 0) continue;
      if (stopWords.has(tokens[i].word) || tokens[i].text === ';') { endIdx = i; break; }
    }
    const condStart = tokens[havingIdx].end;
    const condEnd = endIdx < tokens.length ? tokens[endIdx].start : source.length;
    const condition = source.slice(condStart, condEnd).trim();
    if (!condition) return source;

    /* SELECT-lista elemei: álnevek és a mögöttes kifejezések. */
    const fromIdx = tokens.findIndex((t, i) => t.word === 'FROM' && depths[i] === 0);
    const listEnd = fromIdx >= 0 && fromIdx < havingIdx ? fromIdx : havingIdx;
    const aliasMap = new Map();
    const ranges = [];
    let partStart = 1;
    while (partStart < listEnd && ['DISTINCT', 'ALL', 'DISTINCTROW'].includes(tokens[partStart].word)) partStart++;
    for (let i = partStart; i <= listEnd; i++) {
      const atEnd = i === listEnd;
      if (!atEnd && !(tokens[i].text === ',' && depths[i] === 0)) continue;
      if (i > partStart) ranges.push({ start: partStart, end: i });
      partStart = i + 1;
    }
    for (const range of ranges) {
      const last = tokens[range.end - 1];
      const before = tokens[range.end - 2];
      if (!last || !before) continue;
      /* Az áljel mindig a lista utolsó tokenje; az előtte lévő kifejezés
         záró tokenje AS esetén kettővel, egyébként eggyel korábbi. */
      let alias = null, exprLast = range.end - 2;
      if (before.word === 'AS' && isAtomToken(last)) {
        alias = unquoteName(last.text);
        exprLast = range.end - 3;
      } else if (isAtomToken(last) && before.text !== '.' &&
        (isAtomToken(before) || before.word === ')' || before.word === 'END') &&
        last.start > before.end) {
        alias = unquoteName(last.text);
      }
      if (!alias || exprLast < range.start) continue;
      const expr = source.slice(tokens[range.start].start, tokens[exprLast].end).trim();
      if (expr && !aliasMap.has(alias.toLowerCase())) aliasMap.set(alias.toLowerCase(), expr);
    }

    /* Álnevek helyettesítése a feltételben a mögöttes kifejezéssel. */
    let expanded = condition;
    if (aliasMap.size) {
      const condTokens = tokenize(condition);
      const edits = [];
      for (let i = 0; i < condTokens.length; i++) {
        const t = condTokens[i];
        if (!isAtomToken(t)) continue;
        if (condTokens[i - 1] && condTokens[i - 1].word === '.') continue;
        if (condTokens[i + 1] && condTokens[i + 1].word === '.') continue;
        if (condTokens[i + 1] && condTokens[i + 1].word === '(') continue;
        const expr = aliasMap.get(unquoteName(t.text).toLowerCase());
        if (!expr) continue;
        edits.push({ start: t.start, end: t.end, text: '(' + expr + ')' });
      }
      expanded = applyEdits(condition, edits);
    }

    const whereIdx = tokens.findIndex((t, i) => t.word === 'WHERE' && depths[i] === 0);
    const edits = [];
    if (whereIdx >= 0 && whereIdx < havingIdx) {
      /* Van már WHERE: AND-del hozzáfűzzük, a HAVING-et pedig töröljük. */
      let insertIdx = havingIdx;
      for (let i = whereIdx + 1; i < havingIdx; i++) {
        if (depths[i] !== 0) continue;
        if (['GROUP', 'ORDER', 'LIMIT', 'WINDOW'].includes(tokens[i].word)) { insertIdx = i; break; }
      }
      const insertAt = tokens[insertIdx].start;
      edits.push({ start: insertAt, end: insertAt, text: ' AND (' + expanded + ') ' });
      edits.push({ start: tokens[havingIdx].start, end: condEnd, text: '' });
    } else {
      edits.push({ start: tokens[havingIdx].start, end: tokens[havingIdx].end, text: 'WHERE' });
      edits.push({ start: condStart, end: condEnd, text: ' ' + expanded + ' ' });
    }
    return applyEdits(source, edits);
  }

  /* =======================================================================
   * 8. Utasítás-szintű átírások: DDL, DML, adminisztratív parancsok
   * ===================================================================== */

  const TYPE_MAP = [
    [/^TINYINT$/i, 'INTEGER'], [/^SMALLINT$/i, 'INTEGER'], [/^MEDIUMINT$/i, 'INTEGER'],
    [/^INT$/i, 'INTEGER'], [/^INTEGER$/i, 'INTEGER'], [/^BIGINT$/i, 'INTEGER'],
    [/^TINYINT\s*\(\s*1\s*\)$/i, 'INTEGER'],
    [/^DECIMAL$/i, 'NUMERIC'], [/^NUMERIC$/i, 'NUMERIC'], [/^FIXED$/i, 'NUMERIC'],
    [/^FLOAT$/i, 'REAL'], [/^DOUBLE$/i, 'REAL'], [/^DOUBLE\s+PRECISION$/i, 'REAL'], [/^REAL$/i, 'REAL'],
    [/^BIT$/i, 'INTEGER'], [/^BOOL$/i, 'INTEGER'], [/^BOOLEAN$/i, 'INTEGER'],
    [/^DATE$/i, 'TEXT'], [/^DATETIME$/i, 'TEXT'], [/^TIMESTAMP$/i, 'TEXT'], [/^TIME$/i, 'TEXT'],
    [/^YEAR$/i, 'INTEGER'], [/^CHAR$/i, 'TEXT'], [/^VARCHAR$/i, 'TEXT'], [/^TINYTEXT$/i, 'TEXT'],
    [/^TEXT$/i, 'TEXT'], [/^MEDIUMTEXT$/i, 'TEXT'], [/^LONGTEXT$/i, 'TEXT'],
    [/^NCHAR$/i, 'TEXT'], [/^NVARCHAR$/i, 'TEXT'],
    [/^BINARY$/i, 'BLOB'], [/^VARBINARY$/i, 'BLOB'], [/^TINYBLOB$/i, 'BLOB'], [/^BLOB$/i, 'BLOB'],
    [/^MEDIUMBLOB$/i, 'BLOB'], [/^LONGBLOB$/i, 'BLOB'],
    [/^JSON$/i, 'TEXT'], [/^ENUM$/i, 'TEXT'], [/^SET$/i, 'TEXT'],
    [/^GEOMETRY$/i, 'BLOB'], [/^POINT$/i, 'BLOB'], [/^LINESTRING$/i, 'BLOB'], [/^POLYGON$/i, 'BLOB']
  ];

  function mapColumnType(typeSql) {
    const clean = String(typeSql).replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+UNSIGNED\b/i, '')
      .replace(/\s+ZEROFILL\b/i, '').replace(/\s+CHARACTER\s+SET\s+\w+/i, '')
      .replace(/\s+COLLATE\s+\w+/i, '').trim();
    if (/^ENUM|^SET/i.test(clean)) return "TEXT";
    for (const [re, mapped] of TYPE_MAP) if (re.test(clean)) return mapped;
    if (/^DECIMAL|^NUMERIC/i.test(typeSql)) return 'NUMERIC';
    return clean || 'TEXT';
  }

  /* CREATE TABLE: MySQL-oszlopdefiníciók SQLite-ra alakítása. */
  function rewriteCreateTable(sql) {
    const tokens = codeTokens(sql);
    const openAt = tokens.findIndex(t => t.word === '(');
    if (openAt < 0) return rewriteCreateTableTail(sql);
    const closeAt = pairIndex(tokens, openAt, 1, '(', ')');
    if (closeAt < 0) return rewriteCreateTableTail(sql);

    const body = sql.slice(tokens[openAt].end, tokens[closeAt].start);
    const bodyTokens = codeTokens(body);
    const parts = splitTopLevel(body, bodyTokens, ',');
    const columns = [], constraints = [];

    for (const part of parts) {
      const raw = part.text.trim();
      if (!raw) continue;
      const upper = raw.toUpperCase();
      if (/^(?:CONSTRAINT\b|PRIMARY\s+KEY\b|UNIQUE\b|KEY\b|INDEX\b|FULLTEXT\b|SPATIAL\b|FOREIGN\s+KEY\b|CHECK\b)/.test(upper)) {
        constraints.push(rewriteTableConstraint(raw));
        continue;
      }
      columns.push(rewriteColumnDefinition(raw));
    }
    const rebuilt = columns.concat(constraints.filter(Boolean)).join(',\n  ');
    let out = sql.slice(0, tokens[openAt].end) + '\n  ' + rebuilt + '\n' + sql.slice(tokens[closeAt].start);
    return rewriteCreateTableTail(out);
  }

  function rewriteTableConstraint(raw) {
    let s = raw;
    /* CONSTRAINT név eltávolítása (az SQLite ismeri, de a név ütközhet) */
    s = s.replace(/^CONSTRAINT\s+`?[\w$]+`?\s+/i, '');
    /* FULLTEXT/SPATIAL KEY -> hagyományos index */
    s = s.replace(/^(?:FULLTEXT|SPATIAL)\s+/i, '');
    /* UNIQUE KEY név (oszlopok) -> UNIQUE (oszlopok) */
    const uniqueKey = /^UNIQUE\s+(?:KEY|INDEX)\s+`?[\w$]+`?\s*(\([\s\S]*\))$/i.exec(s);
    if (uniqueKey) return 'UNIQUE ' + uniqueKey[1];
    /* KEY/INDEX nev (oszlopok) -> csak az oszlopok maradnak, az SQLite nem szereti a nevet */
    const keyMatch = /^(?:KEY|INDEX)\s+`?[\w$]+`?\s*(\([\s\S]*\))/i.exec(s);
    if (keyMatch) return null;                     /* az indexet külön hozzuk létre */
    /* FOREIGN KEY ... REFERENCES ... ON UPDATE/DELETE ... – az SQLite ismeri */
    s = s.replace(/\s+ON\s+UPDATE\s+(?:CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION|SET\s+DEFAULT)\b/gi, '');
    s = s.replace(/\s+ON\s+DELETE\s+(?:CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION|SET\s+DEFAULT)\b/gi, '');
    if (/^CHECK\b/i.test(s)) return null;          /* az SQLite CHECK-jét külön kezeljük */
    return s;
  }

  function rewriteColumnDefinition(raw) {
    const tokens = codeTokens(raw);
    if (!tokens.length) return raw;
    const name = raw.slice(0, tokens[0].end - 0).trim();
    let rest = raw.slice(tokens[0].end).trim();

    /* Típus kinyerése: az első zárójelig tartó rész, ügyelve a ENUM('a','b') alakokra. */
    let typeSql = '';
    if (/^ENUM|^SET/i.test(rest)) {
      const close = rest.indexOf(')');
      typeSql = rest.slice(0, close + 1);
      rest = rest.slice(close + 1).trim();
    } else {
      const m = /^([\w\s]+?)(?:\s*\(([^)]*)\))?(?=\s|$)/.exec(rest);
      if (!m) return raw;
      typeSql = m[1].trim() + (m[2] !== undefined ? '(' + m[2] + ')' : '');
      rest = rest.slice(m[0].length).trim();
    }
    const mapped = mapColumnType(typeSql);
    const modifiers = [];
    if (/\bNOT\s+NULL\b/i.test(rest)) modifiers.push('NOT NULL');
    const defaultMatch = /\bDEFAULT\s+('(?:[^']|'')*'|[\w$.+-]+|\([^)]*\))/i.exec(rest);
    if (defaultMatch) {
      let dv = defaultMatch[1];
      if (/^CURRENT_TIMESTAMP(?:\(\d*\))?$/i.test(dv) || /^NOW\(\)$/i.test(dv)) dv = 'CURRENT_TIMESTAMP';
      if (/^NULL$/i.test(dv)) modifiers.push('DEFAULT NULL');
      else modifiers.push('DEFAULT ' + dv);
    }
    if (/\bAUTO_INCREMENT\b/i.test(rest)) modifiers.push('AUTOINCREMENT');
    if (/\bUNIQUE\b/i.test(rest)) modifiers.push('UNIQUE');
    const checkMatch = /\bCHECK\s*(\([\s\S]*?\))\s*(?=\s|$)/i.exec(rest);
    if (checkMatch) modifiers.push('CHECK ' + checkMatch[1]);
    if (/\bPRIMARY\s+KEY\b/i.test(rest)) modifiers.push('PRIMARY KEY');

    const isAutoInc = /\bAUTO_INCREMENT\b/i.test(rest);
    const columnType = isAutoInc ? 'INTEGER' : mapped;
    /* Az AUTOINCREMENT csak INTEGER PRIMARY KEY mellett érvényes. */
    if (isAutoInc && !/\bPRIMARY\s+KEY\b/i.test(rest)) {
      const idx = modifiers.indexOf('AUTOINCREMENT');
      if (idx >= 0) modifiers.splice(idx, 1);
    }
    const uniqueMod = modifiers.filter(m => m !== 'AUTOINCREMENT');
    return (name + ' ' + columnType + ' ' + uniqueMod.join(' ')).trim();
  }

  function rewriteCreateTableTail(sql) {
    let out = sql;
    out = out.replace(/\s*ENGINE\s*=\s*\w+/gi, '');
    out = out.replace(/\s*(?:DEFAULT\s+)?CHARSET\s*=\s*\w+/gi, '');
    out = out.replace(/\s*(?:DEFAULT\s+)?CHARACTER\s+SET\s*=\s*\w+/gi, '');
    out = out.replace(/\s*COLLATE\s*=\s*\w+/gi, '');
    out = out.replace(/\s*ROW_FORMAT\s*=\s*\w+/gi, '');
    out = out.replace(/\s*AUTO_INCREMENT\s*=\s*\d+/gi, '');
    out = out.replace(/\s*COMMENT\s*=\s*'(?:[^']|'')*'/gi, '');
    out = out.replace(/\s*COMMENT\s+'(?:[^']|'')*'/gi, '');
    return out.trim();
  }

  /* CREATE DATABASE / DROP DATABASE / USE -> ATTACH / DETACH. */
  function rewriteDatabaseStatements(sql) {
    const stmts = splitStatements(sql);
    const out = [];
    for (const raw of stmts) {
      const s = raw.trim();
      if (!s) continue;
      let m;
      if ((m = /^CREATE\s+(?:DATABASE|SCHEMA)\s+(?:IF\s+NOT\s+EXISTS\s+)?(`[^`]+`|[\w$]+)[\s\S]*$/i.exec(s))) {
        out.push({ kind: 'attach', schema: unquoteName(m[1]) });
        continue;
      }
      if ((m = /^(?:DROP|ALTER)\s+(?:DATABASE|SCHEMA)\s+(?:IF\s+EXISTS\s+)?(`[^`]+`|[\w$]+)[\s\S]*$/i.exec(s))) {
        out.push({ kind: 'detach', schema: unquoteName(m[1]) });
        continue;
      }
      if ((m = /^USE\s+(`[^`]+`|[\w$]+)\s*$/i.exec(s))) {
        out.push({ kind: 'use', schema: unquoteName(m[1]) });
        continue;
      }
      if ((m = /^(?:TRUNCATE\s+(?:TABLE\s+)?)([\s\S]+)$/i.exec(s))) {
        const targets = splitTargets(m[1]).map(quoteTableRef);
        for (const target of targets) out.push({ kind: 'sql', text: 'DELETE FROM ' + target });
        continue;
      }
      if ((m = /^(?:RENAME\s+TABLE\s+)([\s\S]+)$/i.exec(s))) {
        const pairs = splitTargets(m[1]);
        for (const pair of pairs) {
          const rename = /^([\s\S]+?)\s+TO\s+([\s\S]+)$/i.exec(pair);
          if (!rename) continue;
          out.push({ kind: 'sql', text: 'ALTER TABLE ' + quoteTableRef(rename[1].trim()) + ' RENAME TO ' + quoteName(unquoteName(rename[2].trim())) });
        }
        continue;
      }
      if (/^(?:SHOW|DESCRIBE|DESC|EXPLAIN|ANALYZE|OPTIMIZE|CHECK|REPAIR|FLUSH|LOCK\s+TABLES|UNLOCK\s+TABLES|START\s+TRANSACTION\s+READ|SAVEPOINT|RELEASE\s+SAVEPOINT)/i.test(s)) {
        out.push({ kind: 'admin', text: s });
        continue;
      }
      /* SET ... : felhasználói változók és munkamenet-beállítások. Az SQLite
         nem ismeri, ezért csendben kihagyjuk (a tananyag nem épít rájuk). */
      if (/^SET\b/i.test(s)) {
        out.push({ kind: 'noop', text: s });
        continue;
      }
      /* Felhasználókezelés: a tananyagban nem cél, csendben kihagyjuk. */
      if (/^(?:GRANT|REVOKE)\b/i.test(s)) {
        out.push({ kind: 'noop', text: s });
        continue;
      }
      if (/^(?:CREATE|DROP|ALTER)\s+(?:USER|ROLE|TABLESPACE|SERVER|EVENT|FUNCTION|PROCEDURE|TRIGGER|DEFINER)/i.test(s)) {
        out.push({ kind: 'noop', text: s });
        continue;
      }
      /* DROP TABLE a, b [, c] -> több külön DROP TABLE. */
      if ((m = /^DROP\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+EXISTS\s+)?([\s\S]+)$/i.exec(s))) {
        const ifExists = /^DROP\s+(?:TEMPORARY\s+)?TABLE\s+IF\s+EXISTS\b/i.test(s);
        const targets = splitTargets(m[1]).map(quoteTableRef);
        for (const target of targets) {
          out.push({ kind: 'sql', text: 'DROP TABLE ' + (ifExists ? 'IF EXISTS ' : '') + target });
        }
        continue;
      }
      /* CREATE OR REPLACE VIEW -> DROP VIEW IF EXISTS + CREATE VIEW. */
      if ((m = /^CREATE\s+OR\s+REPLACE\s+(?:ALGORITHM\s*=\s*\w+\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:SQL\s+SECURITY\s+\w+\s+)?VIEW\s+([\s\S]+)$/i.exec(s))) {
        const rest = m[1];
        const viewName = /^(`[^`]+`|[\w$.]+)/.exec(rest);
        if (viewName) {
          out.push({ kind: 'sql', text: 'DROP VIEW IF EXISTS ' + quoteTableRef(viewName[1]) });
          out.push({ kind: 'sql', text: 'CREATE VIEW ' + rest });
          continue;
        }
      }
      out.push({ kind: 'raw', text: s });
    }
    return out;
  }

  function unquoteName(name) {
    return String(name).trim().replace(/^[`"]|[`"]$/g, '').replace(/``/g, '`');
  }
  function quoteName(name, quote) {
    const q = quote === undefined ? '"' : quote;
    return q + String(name).replace(new RegExp(q === '"' ? '"' : q, 'g'), q + q) + q;
  }
  /* Táblahivatkozás idézőjelezve, de séma hozzáadása nélkül: a tananyag
     egyetlen (main) sémában dolgozik, a USE / CREATE DATABASE csak jelzés. */
  function quoteTableRef(name) {
    return String(name).trim().split('.')
      .map(part => quoteName(unquoteName(part.trim())))
      .join('.');
  }
  function splitTargets(text) {
    return splitTopLevel(text, codeTokens(text), ',').map(p => p.text.trim()).filter(Boolean);
  }

  /* Utasítások bontása pontosvessző mentén, szövegkonstansok figyelembevételével. */
  function splitStatements(sql) {
    const tokens = tokenize(sql);
    const out = [];
    let start = 0;
    for (const token of tokens) {
      if (token.text !== ';') continue;
      out.push(sql.slice(start, token.start));
      start = token.end;
    }
    out.push(sql.slice(start));
    return out.map(s => stripLeadingTrivia(s)).filter(s => s.trim().length);
  }

  /* A sor eleji szóközök és kommentek levágása (a MySQL-parancsok
     felismeréséhez, mert a CREATE DATABASE előtt gyakran áll komment). */
  function stripLeadingTrivia(sql) {
    let s = String(sql);
    for (;;) {
      const trimmed = s.replace(/^\s+/, '');
      if (trimmed.startsWith('--') || trimmed.startsWith('#')) {
        const newline = trimmed.indexOf('\n');
        if (newline < 0) return '';
        s = trimmed.slice(newline + 1);
        continue;
      }
      if (trimmed.startsWith('/*')) {
        const end = trimmed.indexOf('*/');
        if (end < 0) return '';
        s = trimmed.slice(end + 2);
        continue;
      }
      return trimmed;
    }
  }

  /* =======================================================================
   * 9. DUAL, information_schema és egyéb MySQL-környezet pótlása
   * ===================================================================== */

  /* A DUAL tábla pótlása: SELECT ... FROM DUAL esetén a FROM DUAL eltűnik.
     Ha viszont valódi DUAL tábla létezik (a tananyag egyik oldala ilyet hoz
     létre), akkor a hivatkozást meghagyjuk. */
  function rewriteDual(sql) {
    if (!/\bFROM\s+`?dual`?\b/i.test(sql)) return sql;
    if (hasUserTable('dual')) return sql;
    return sql.replace(/\bFROM\s+DUAL\b/gi, '')
      .replace(/\bFROM\s+`?dual`?\s+AS\s+`?[\w$]+`?/gi, '')
      .replace(/\bFROM\s+`?dual`?\s+`?[\w$]+`?/gi, '');
  }

  /* Létezik-e ilyen nevű tábla/nézet az aktuális adatbázisban? */
  function hasUserTable(name) {
    const db = defaultState.db;
    if (!db) return false;
    try {
      const sql = "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND lower(name) = " +
        JSON.stringify(String(name).toLowerCase()) + ' LIMIT 1';
      const rows = db.exec(sql);
      return !!(rows && rows.length && rows[0].values.length);
    } catch (e) {
      return false;
    }
  }

  /* information_schema "táblák" helyettesítése alkérdéssel. Azért nem
     nézettel, mert az SQLite-ban a más sémában lévő nézet nem hivatkozhat
     a main sémára. A main-re mutató unqualified sqlite_master viszont a
     legfelső szintű lekérdezésben helyesen a fő adatbázist jelöli. */
  const INFO_SCHEMA_SUBQUERIES = {
    tables: `SELECT 'adatbazis' AS table_schema, name AS table_name,
        CASE WHEN type = 'view' THEN 'VIEW' ELSE 'BASE TABLE' END AS table_type,
        'InnoDB' AS engine, 0 AS table_rows
      FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'`,
    columns: `SELECT 'adatbazis' AS table_schema, m.name AS table_name, p.name AS column_name,
        p.cid + 1 AS ordinal_position, p.dflt_value AS column_default,
        CASE WHEN p."notnull" = 1 OR p.pk > 0 THEN 'NO' ELSE 'YES' END AS is_nullable,
        p.type AS data_type, p.type AS column_type
      FROM sqlite_master m JOIN pragma_table_info(m.name) p
      WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%'`,
    statistics: `SELECT 'adatbazis' AS table_schema, m.name AS table_name, il.name AS index_name,
        CASE WHEN il."unique" = 1 THEN 0 ELSE 1 END AS non_unique,
        ii.name AS column_name, ii.seqno + 1 AS seq_in_index
      FROM sqlite_master m
      JOIN pragma_index_list(m.name) il
      JOIN pragma_index_info(il.name) ii
      WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'`,
    key_column_usage: `SELECT 'adatbazis' AS table_schema, m.name AS table_name,
        il.name AS constraint_name, ii.name AS column_name,
        ii.seqno + 1 AS ordinal_position
      FROM sqlite_master m
      JOIN pragma_index_list(m.name) il
      JOIN pragma_index_info(il.name) ii
      WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'`,
    schemata: `SELECT 'adatbazis' AS schema_name, 'utf8mb4' AS default_character_set_name,
        'utf8mb4_hungarian_ci' AS default_collation_name`,
    table_constraints: `SELECT 'adatbazis' AS table_schema, m.name AS table_name,
        p.name AS constraint_name,
        CASE WHEN p.pk > 0 THEN 'PRIMARY KEY' ELSE 'UNIQUE' END AS constraint_type
      FROM sqlite_master m JOIN pragma_table_info(m.name) p
      WHERE m.type = 'table' AND p.pk > 0 AND m.name NOT LIKE 'sqlite_%'`
  };

  /* Hivatkozás: information_schema.<tábla> -> (alkérdés). */
  function rewriteInformationSchema(sql) {
    if (!/information_schema\s*\./i.test(sql)) return sql;
    const tokens = codeTokens(sql);
    const edits = [];
    for (let i = 0; i < tokens.length; i++) {
      if (unquoteName(tokens[i].text).toLowerCase() !== 'information_schema') continue;
      if (!tokens[i + 1] || tokens[i + 1].text !== '.') continue;
      const nameToken = tokens[i + 2];
      if (!nameToken) continue;
      const name = unquoteName(nameToken.text).toLowerCase();
      const sub = INFO_SCHEMA_SUBQUERIES[name];
      if (!sub) continue;
      edits.push({ start: tokens[i].start, end: nameToken.end, text: '(' + sub + ')' });
      i += 2;
    }
    return applyEdits(sql, edits);
  }

  /* Az information_schema csak jelzésképp létezik: a hivatkozásokat a
     rewriteInformationSchema() alakítja alkérdéssé, mert az SQLite-ban a
     más sémában lévő nézet nem hivatkozhat a main sémára. */
  function ensureInformationSchema(db) {
    if (!db) return;
    try {
      const attached = db.exec("SELECT name FROM pragma_database_list")[0];
      const names = attached ? attached.values.map(r => String(r[0]).toLowerCase()) : [];
      if (!names.includes('information_schema')) {
        db.run("ATTACH DATABASE ':memory:' AS information_schema");
      }
    } catch (e) { /* information_schema nem kritikus */ }
  }

  /* A `-- ` kommentekből származó különleges MySQL-parancsok. */
  function rewriteShow(sql) {
    const s = sql.trim().replace(/;$/, '');
    let m;
    if ((m = /^SHOW\s+(?:FULL\s+)?TABLES(?:\s+FROM\s+(`?[\w$]+`?))?(?:\s+LIKE\s+('(?:[^']|'')*'))?$/i.exec(s))) {
      const pattern = m[2] ? m[2].slice(1, -1).replace(/''/g, "'").replace(/%/g, '*').replace(/_/g, '?') : '*';
      return { kind: 'table', sql: "SELECT name AS `Tables_in_" + (m[1] ? unquoteName(m[1]) : 'adatbazis') + "`" +
        " FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'" +
        (m[2] ? " AND name GLOB '" + pattern.replace(/'/g, "''") + "'" : '') + ' ORDER BY name' };
    }
    if ((m = /^(?:DESCRIBE|DESC|SHOW\s+(?:FULL\s+)?COLUMNS\s+FROM)\s+(`?[\w$.]+`?)$/i.exec(s))) {
      const table = unquoteName(m[1]);
      const dot = table.lastIndexOf('.');
      const bare = dot > 0 ? table.slice(dot + 1) : table;
      const schema = dot > 0 ? table.slice(0, dot) : null;
      const args = schema
        ? "'" + bare.replace(/'/g, "''") + "','" + schema.replace(/'/g, "''") + "'"
        : "'" + bare.replace(/'/g, "''") + "'";
      return {
        kind: 'columns', sql: "SELECT name AS Field, type AS Type, CASE WHEN \"notnull\"=0 AND pk=0 THEN 'YES' ELSE 'NO' END AS `Null`," +
          " CASE WHEN pk>0 THEN 'PRI' ELSE '' END AS `Key`, dflt_value AS `Default`, '' AS Extra" +
          " FROM pragma_table_info(" + args + ")"
      };
    }
    if ((m = /^SHOW\s+(?:INDEX|INDEXES|KEYS)\s+FROM\s+(`?[\w$.]+`?)$/i.exec(s))) {
      const table = unquoteName(m[1]);
      const dot = table.lastIndexOf('.');
      const bare = dot > 0 ? table.slice(dot + 1) : table;
      const schema = dot > 0 ? table.slice(0, dot) : null;
      const indexArgs = schema
        ? "'" + bare.replace(/'/g, "''") + "','" + schema.replace(/'/g, "''") + "'"
        : "'" + bare.replace(/'/g, "''") + "'";
      return {
        kind: 'indexes', sql: "SELECT '" + bare.replace(/'/g, "''") + "' AS `Table`, il.name AS Key_name, CASE WHEN il.\"unique\"=0 THEN 1 ELSE 0 END AS Non_unique," +
          " ii.name AS Column_name, ii.seqno+1 AS Seq_in_index" +
          " FROM pragma_index_list(" + indexArgs + ") il JOIN pragma_index_info(il.name) ii"
      };
    }
    if ((m = /^SHOW\s+DATABASES$/i.exec(s))) {
      return { kind: 'databases', sql: "SELECT CASE WHEN name='main' THEN 'adatbazis' ELSE name END AS `Database` FROM pragma_database_list WHERE name NOT IN ('temp','information_schema')" };
    }
    if ((m = /^SHOW\s+CREATE\s+TABLE\s+(`?[\w$.]+`?)$/i.exec(s))) {
      const table = unquoteName(m[1]);
      const dot = table.lastIndexOf('.');
      const bare = dot > 0 ? table.slice(dot + 1) : table;
      const schema = dot > 0 ? table.slice(0, dot) : null;
      const masterRef = schema ? '"' + schema.replace(/"/g, '""') + '".sqlite_master' : 'sqlite_master';
      return {
        kind: 'create', sql: "SELECT name AS `Table`, sql AS `Create Table` FROM " + masterRef + " WHERE name='" + bare.replace(/'/g, "''") + "'"
      };
    }
    if ((m = /^SHOW\s+CREATE\s+(?:DATABASE|SCHEMA)\s+(`?[\w$]+`?)$/i.exec(s))) {
      return { kind: 'create', sql: "SELECT '" + unquoteName(m[1]).replace(/'/g, "''") + "' AS `Database`, '' AS `Create Database`" };
    }
    if (/^SHOW\s+(?:WARNINGS|ERRORS)$/i.test(s)) {
      return { kind: 'warnings', sql: null };
    }
    if (/^SHOW\s+VARIABLES\b/i.test(s)) {
      return { kind: 'variables', sql: "SELECT '' AS Variable_name, '' AS Value WHERE 0" };
    }
    if (/^SHOW\s+(?:STATUS|ENGINES|CHARSET|COLLATION|GRANTS|PROCESSLIST|TABLE\s+STATUS)\b/i.test(s)) {
      return { kind: 'admin', sql: 'SELECT 1 AS uzenet WHERE 0' };
    }
    if (/^EXPLAIN\b/i.test(s)) {
      return { kind: 'explain', sql: 'EXPLAIN QUERY PLAN ' + s.replace(/^EXPLAIN(?:\s+(?:FORMAT\s*=\s*\w+|ANALYZE|EXTENDED))?\s+/i, '') };
    }
    return null;
  }

  /* =======================================================================
   * 10. A teljes átírás és a futtató burkoló
   * ===================================================================== */

  /* Egyetlen utasítás átírása (függvény-, kifejezés- és DDL-szint). */
  function rewriteStatement(sql) {
    const show = rewriteShow(sql);
    if (show) return { kind: show.kind, sql: show.sql };
    if (/^\s*(?:CREATE|ALTER)\s+(?:DATABASE|SCHEMA)\b/i.test(sql)) {
      return { kind: 'noop', sql: null };
    }
    /* TRUNCATE TABLE / RENAME TABLE: már SQLite-ra alakított utasítás(ok). */
    const dbPlans = rewriteDatabaseStatements(sql);
    if (dbPlans.length && dbPlans[0].kind === 'sql' &&
      dbPlans[0].text.trim() !== sql.trim()) {
      return { kind: 'sql', sql: dbPlans.map(p => p.text).join('; ') };
    }
    if (dbPlans.length && (dbPlans[0].kind === 'noop' || dbPlans[0].kind === 'admin')) {
      return { kind: dbPlans[0].kind, sql: null, text: dbPlans[0].text };
    }
    let out = normalizeTokens(sql);
    out = rewriteGetFormat(out);
    out = rewriteSelectInto(out);
    out = rewriteRollup(out);
    out = rewriteDual(out);
    out = rewriteInformationSchema(out);
    if (/^\s*CREATE\s+(?:TEMPORARY\s+)?TABLE\b/i.test(out)) out = rewriteCreateTable(out);
    if (/^\s*CREATE\s+(?:TEMPORARY\s+)?TABLE\b/i.test(out) && /\bLIKE\b/i.test(out)) out = rewriteCreateTableLike(out);
    if (/^\s*ALTER\s+TABLE\b/i.test(out)) out = rewriteAlterTable(out);
    if (/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(out)) out = rewriteCreateIndex(out);
    if (/^\s*(?:INSERT|REPLACE)\b/i.test(out)) out = rewriteInsert(out);
    if (/^\s*(?:UPDATE|DELETE)\b/i.test(out)) out = rewriteRowLimit(out);
    out = rewriteIntervals(out);
    out = rewriteLooseHaving(out);
    out = rewriteCast(out);
    out = rewriteTrim(out);
    out = rewriteGroupConcat(out);
    out = rewriteSmallSyntax(out);
    out = rewriteArithmetic(out);
    out = rewriteFunctionNames(out);
    out = rewriteModifiers(out);
    out = rewriteDateLiterals(out);
    if (out.trim() === '{noop}' || !out.trim()) return { kind: 'noop', sql: null };
    return { kind: 'sql', sql: out.trim() };
  }

  /* CREATE TABLE u LIKE t -> CREATE TABLE u AS SELECT * FROM t WHERE 0
     (az SQLite nem ismeri a LIKE záradékot; a szerkezet így másolódik). */
  function rewriteCreateTableLike(sql) {
    const m = /^(\s*CREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(`?[\w$]+`?(?:\s*\.\s*`?[\w$]+`?)?)\s+LIKE\s+(`?[\w$]+`?(?:\s*\.\s*`?[\w$]+`?)?)\s*$/i.exec(sql);
    if (!m) return sql;
    return m[1] + m[2] + ' AS SELECT * FROM ' + m[3] + ' WHERE 0';
  }

  /* ALTER TABLE ... ADD/MODIFY/CHANGE oszlop -> SQLite-barát alak. */
  function rewriteAlterTable(sql) {    let out = sql;
    /* ALTER TABLE ... MODIFY COLUMN: az SQLite nem tudja, ezért kihagyjuk
       (a lekérdezés így is lefut, csak a módosítás marad el). */
    if (/^ALTER\s+TABLE\s+[\s\S]*?\s+MODIFY\s+(?:COLUMN\s+)?/i.test(out)) {
      out = out.replace(/^(ALTER\s+TABLE\s+[\s\S]+?)\s+MODIFY\s+(?:COLUMN\s+)?[\s\S]*$/i, '$1');
      if (/^ALTER\s+TABLE\s+[\w$.`]+\s*$/i.test(out.trim())) return '{noop}';
    }
    /* ADD [CONSTRAINT n] PRIMARY KEY (...) / ADD UNIQUE ...: az SQLite nem
       tud kulcsot hozzáadni, ezért egyedi indexet hozunk létre helyette.
       A visszatérési érték { kind: 'sql', sql } több utasítást is takarhat. */
    const addKey = /^ALTER\s+TABLE\s+([\s\S]+?)\s+ADD\s+(?:CONSTRAINT\s+`?[\w$]+`?\s+)?(PRIMARY\s+KEY|UNIQUE)\s*(\([\s\S]+\))\s*$/i.exec(out.trim());
    if (addKey) {
      const table = unquoteName(addKey[1].trim());
      const indexName = (addKey[2].toUpperCase().startsWith('PRIMARY') ? 'pk_' : 'uq_') + table + '_' + Math.random().toString(36).slice(2, 7);
      return 'CREATE UNIQUE INDEX ' + quoteName(indexName) + ' ON ' + quoteTableRef(table) + ' ' + addKey[3];
    }
    /* DROP PRIMARY KEY -> nincs rá SQLite-megfelelő, kihagyjuk. */
    if (/^ALTER\s+TABLE\s+[\s\S]+\s+DROP\s+PRIMARY\s+KEY\s*$/i.test(out.trim())) return '{noop}';
    out = out.replace(/\s+AFTER\s+`?[\w$]+`?/gi, '');
    out = out.replace(/\s+FIRST\b/gi, '');
    /* CHANGE régi új tipus -> RENAME COLUMN régi TO új (csak ha van új név) */
    const change = /^(ALTER\s+TABLE\s+[\s\S]+?)\s+CHANGE\s+(?:COLUMN\s+)?(`?[\w$]+`?)\s+(`?[\w$]+`?)[\s\S]*$/i.exec(out);
    if (change) out = change[1] + ' RENAME COLUMN ' + change[2] + ' TO ' + change[3];
    /* ADD COLUMN IF NOT EXISTS – az SQLite nem ismeri, hagyjuk el a feltételt */
    out = out.replace(/\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/gi, 'ADD COLUMN');
    return out;
  }

  /* CREATE INDEX: USING BTREE/HASH, oszlophossz levágása. */
  function rewriteCreateIndex(sql) {
    let out = sql.replace(/\s+USING\s+(?:BTREE|HASH)\b/gi, '');
    out = out.replace(/(\([\s\S]*?\))/g, body => body.replace(/`?([\w$]+)`?\s*\(\s*\d+\s*\)/g, '`$1`'));
    return out;
  }

  /* Dátumliterálok: DATE '2024-01-01' / TIMESTAMP '...' -> egyszerű szöveg. */
  function rewriteDateLiterals(sql) {
    return sql
      .replace(/\bDATE\s+'((?:\d{4}-\d{2}-\d{2})|(?:\d{8}))'/gi, "'$1'")
      .replace(/\bTIMESTAMP\s+'([^']*)'/gi, "'$1'")
      .replace(/\bTIME\s+'([^']*)'/gi, "'$1'");
  }

  /* Teljes SQL (több utasítás is) átírása egyetlen SQLite-futtatható szöveggé. */
  function rewrite(sql, options) {
    const source = String(sql == null ? '' : sql);
    if (!source.trim()) return '';
    const parts = [];
    for (const plan of planStatements(source)) {
      if (plan.kind === 'noop') parts.push('SELECT 1 WHERE 0');
      else if (plan.sql) parts.push(plan.sql);
      /* attach/detach/use: nem SQL-szöveg, ezeket az execute() kezeli. */
    }
    return parts.join(';\n');
  }

  /* =======================================================================
   * 11. Futtatás hook-okkal: CREATE DATABASE, USE, SHOW, több utasítás
   * ===================================================================== */

  function planStatements(sql) {
    const source = String(sql == null ? '' : sql);
    const out = [];
    for (const raw of splitStatements(source)) {
      const stmt = raw.trim();
      if (!stmt) continue;
      const dbPlans = rewriteDatabaseStatements(stmt);
      const dbPlan = dbPlans[0];
      if (!dbPlan) continue;
      if (dbPlan.kind === 'attach' || dbPlan.kind === 'detach' || dbPlan.kind === 'use') { out.push(dbPlan); continue; }
      if (dbPlan.kind === 'admin') {
        const show = rewriteShow(dbPlan.text);
        if (show) { out.push(show); continue; }
        out.push(dbPlan);
        continue;
      }
      /* TRUNCATE / RENAME TABLE: már SQLite-ra alakított utasítás(ok). */
      if (dbPlan.kind === 'sql') {
        for (const plan of dbPlans) if (plan.text) out.push({ kind: 'sql', sql: plan.text });
        continue;
      }
      if (dbPlan.kind === 'noop') { out.push({ kind: 'noop', sql: null }); continue; }
      out.push(rewriteStatement(stmt));
    }
    return out;
  }

  /* A beépített db.exec-et kiegészítő futtató: kezeli a MySQL-parancsokat. */
  function execute(sql, db) {
    const database = db || defaultState.db;
    if (!database) throw new Error('Nincs inicializált adatbázis. Hívd meg előbb az install(db) függvényt.');
    const results = [];
    const runner = database.__mysql9OriginalExec || database.exec.bind(database);
    const runRaw = database.__mysql9OriginalRun || database.run.bind(database);
    for (const plan of planStatements(sql)) {
      if (plan.kind === 'attach') {
        try { runRaw.call(database, 'ATTACH DATABASE \':memory:\' AS ' + quoteName(plan.schema)); }
        catch (e) { /* már létezik */ }
        continue;
      }
      if (plan.kind === 'detach') {
        try { runRaw.call(database, 'DETACH DATABASE ' + quoteName(plan.schema)); } catch (e) { /* nincs ilyen */ }
        continue;
      }
      if (plan.kind === 'use') {
        defaultState.schema = plan.schema === 'adatbazis' ? 'main' : plan.schema;
        continue;
      }
      if (plan.kind === 'noop') continue;
      if (plan.kind === 'warnings') {
        results.push({ columns: ['Level', 'Code', 'Message'], values: defaultState.warnings.map(w => ['Warning', w.code || 0, w.message]) });
        defaultState.warnings = [];
        continue;
      }
      if (plan.kind === 'variables') {
        results.push({ columns: ['Variable_name', 'Value'], values: [] });
        continue;
      }
      if (plan.kind === 'admin' && !plan.sql && plan.text) {
        runRaw.call(database, plan.text);
        continue;
      }
      const text = plan.sql || plan.text;
      if (!text) continue;
      /* Mindig az eredeti motort hívjuk, különben a felülírt db.exec végtelen
         rekurzióba futna. */
      const runner = database.__mysql9OriginalExec || database.exec;
      const r = runner.call(database, text);
      if (r.length) results.push(...r);
    }
    return results;
  }

  /* =======================================================================
   * 12. Regisztráció az sql.js motorba
   * ===================================================================== */

  /* A megadott aritású (0..6) szilárd hívásburkoló. */
  function fixedCallback(fn, arity) {
    const run = args => {
      try {
        const result = fn.apply(null, args);
        if (result === undefined) return null;
        if (typeof result === 'boolean') return result ? 1 : 0;
        if (typeof result === 'bigint') return Number(result);
        /* Az SQLite nem tud Infinity/NaN értéket tárolni; a MySQL ilyenkor
           NULL-t (vagy hibát) ad, ezért itt is NULL lesz. */
        if (typeof result === 'number' && !Number.isFinite(result)) return null;
        return result;
      } catch (error) {
        if (error instanceof RangeError) throw error;
        return null;
      }
    };
    switch (arity) {
      case 0: return () => run([]);
      case 1: return a => run([a]);
      case 2: return (a, b) => run([a, b]);
      case 3: return (a, b, c) => run([a, b, c]);
      case 4: return (a, b, c, d) => run([a, b, c, d]);
      case 5: return (a, b, c, d, e) => run([a, b, c, d, e]);
      default: return (a, b, c, d, e, f) => run([a, b, c, d, e, f]);
    }
  }

  /* Változó számú argumentumot elfogadó (fn.length = -1) hívásburkoló. */
  function variadicCallback(fn) {
    const callback = function () {
      const args = Array.prototype.slice.call(arguments);
      try {
        const result = fn.apply(null, args);
        if (result === undefined) return null;
        if (typeof result === 'boolean') return result ? 1 : 0;
        if (typeof result === 'bigint') return Number(result);
        return result;
      } catch (error) {
        if (error instanceof RangeError) throw error;
        return null;
      }
    };
    Object.defineProperty(callback, 'length', { value: -1 });
    return callback;
  }

  /* A MySQL függvényeinek nagy része NULL argumentumra NULL-t ad. Ezt a
     def() harmadik paramétere vezérli: ha a függvény NEM kapott
     { passNull: true } jelzést, minden NULL argumentumot automatikusan
     NULL eredménnyé alakítunk (pl. ABS(NULL) -> NULL, nem 0). */
  function nullGuard(fn) {
    const guarded = (...args) => args.some(isNull) ? null : fn(...args);
    return guarded;
  }

  function makeCallback(spec, arity) {
    const fn = spec.passNull ? spec.fn : nullGuard(spec.fn);
    if (arity === -1) return variadicCallback(fn);
    return fixedCallback(fn, arity);
  }

  function installFunctions(db) {
    if (!db || typeof db.create_function !== 'function') throw new Error('Az install(db) egy sql.js Database objektumot vár.');
    /* FONTOS: a sql.js create_function() a függvényt NÉV szerint tárolja
       (this.functions[name]), ezért ha ugyanazt a nevet több aritással
       regisztráljuk, a második regisztráció felszabadítja az első
       hívásszálát – a korábbi aritású hívás csendben NULL-t ad. Ezért a
       több aritású függvényeket egyetlen, változó argumentumú
       (length = -1) hívással regisztráljuk, és a belépő
       argumentumszám alapján a függvény maga dönt. */
    const byName = new Map();
    for (const spec of scalars) {
      if (!byName.has(spec.name)) byName.set(spec.name, { spec, arities: [] });
      const entry = byName.get(spec.name);
      for (const arity of spec.arity) {
        if (!entry.arities.includes(arity)) entry.arities.push(arity);
      }
    }
    for (const [name, entry] of byName) {
      const { spec, arities } = entry;
      const single = arities.length === 1 ? arities[0] : -1;
      if (single === -1) {
        try { db.create_function(name, makeCallback(spec, -1)); } catch (e) { /* tovább */ }
        continue;
      }
      if (single === 0) {
        try { db.create_function(name, makeCallback(spec, 0)); } catch (e) { /* tovább */ }
        continue;
      }
      try {
        db.create_function(name, makeCallback(spec, single));
      } catch (e) {
        /* Ha az adott aritás nem regisztrálható, változó alakkal próbáljuk. */
        try { db.create_function(name, makeCallback(spec, -1)); } catch (e2) { /* tovább */ }
      }
    }
    /* Belső segédfüggvények az átíráshoz. [név, függvény, aritás] */
    const helpers = [
      ['MYSQL_DATE_ADD', (v, u, n) => dateAdd(v, u, n), [3]],
      ['MYSQL_DATE_SUB', (v, u, n) => dateSub(v, u, n), [3]],
      ['MYSQL_DIV', (a, b) => integerDivide(a, b), [2]],
      ['MYSQL_MOD', (a, b) => modulo(a, b), [2]],
      ['MYSQL_REAL_DIV', (a, b) => realDivide(a, b), [2]],
      ['MYSQL_BIT_XOR', (a, b) => { const x = truncInt(a), y = truncInt(b); return x === null || y === null ? null : (x ^ y); }, [2]],
      ['MYSQL_XOR', (a, b) => {
        if (isNull(a) || isNull(b)) return null;
        return (num(a) ? 1 : 0) ^ (num(b) ? 1 : 0);
      }, [2]],
      ['MYSQL_BIT_AND', (a, b) => { const x = truncInt(a), y = truncInt(b); return x === null || y === null ? null : (x & y); }, [2]],
      ['MYSQL_BIT_OR', (a, b) => { const x = truncInt(a), y = truncInt(b); return x === null || y === null ? null : (x | y); }, [2]],
      ['MYSQL_CAST_CHAR', (v, n) => {
        if (isNull(v)) return null;
        let text;
        if (typeof v === 'number') text = Number.isInteger(v) ? String(v) : String(v);
        else if (v instanceof Uint8Array) text = asText(v);
        else text = asText(v);
        if (text === null) return null;
        return isNull(n) ? text : Array.from(text).slice(0, Math.max(0, truncInt(n))).join('');
      }, [1, 2]],
      /* CAST(x AS DECIMAL(p,s)): a megadott tizedesjegyre kerekít. */
      ['MYSQL_CAST_DECIMAL', (v, scale) => {
        const x = num(v);
        if (x === null) return null;
        return roundTo(x, scale === undefined || scale === null ? 0 : truncInt(scale));
      }, [1, 2]],
      ['MYSQL_ROUND', (v, p) => roundTo(v, p), [1, 2]],
      ['MYSQL_CONCAT', concat, ['*']],
      ['MYSQL_CONCAT_ROW', (...values) => values.some(isNull) ? null : values.map(asText).join(''), ['*']],
      ['MYSQL_CONCAT_WS', concatWs, ['*']],
      ['MYSQL_IF', (c, a, b) => num(c) ? a : b, [3]],
      ['MYSQL_GREATEST', (...values) => {
        if (!values.length || values.some(isNull)) return null;
        let best = values[0];
        for (const v of values) if (compareValues(v, best) > 0) best = v;
        return best;
      }, ['*']],
      ['MYSQL_LEAST', (...values) => {
        if (!values.length || values.some(isNull)) return null;
        let best = values[0];
        for (const v of values) if (compareValues(v, best) < 0) best = v;
        return best;
      }, ['*']],
      ['MYSQL_CHAR', (...values) => values.map(v => {
        const k = truncInt(v);
        return k === null ? '' : String.fromCodePoint(((k % 0x110000) + 0x110000) % 0x110000);
      }).join(''), ['*']],
      ['MYSQL_FIND_IN_SET', (n, l) => findInSet(n, l), [2]],
      ['MYSQL_OCTET_LENGTH', v => octetLength(v), [1]],
      ['MYSQL_FORMAT', (v, d, l) => formatNumber(v, d === undefined ? 0 : d, l), [2, 3]],
      ['MYSQL_DATE', v => mysqlDate(v), [1]],
      ['MYSQL_TIME', v => mysqlTime(v), [1]],
      ['MYSQL_TIMESTAMP', v => { const d = mysqlDate(v); return d === null ? null : d + ' 00:00:00'; }, [1, 2]],
      ['MYSQL_LOCATE', (needle, haystack, start) => {
        const h = asText(haystack), n = asText(needle);
        if (h === null || n === null) return null;
        /* Karakteralapú keresés, karakterben értelmezett kezdőpozícióval. */
        const chars = Array.from(h);
        const from = isNull(start) ? 0 : Math.min(chars.length, Math.max(0, truncInt(start) - 1));
        const tail = chars.slice(from).join('');
        const index = tail.indexOf(n);
        if (index < 0) return 0;
        return from + Array.from(tail.slice(0, index)).length + 1;
      }, [2, 3]],
      ['MYSQL_TIMESTAMPDIFF', (u, a, b) => timestampdiff(u, a, b), [3]],
      ['MYSQL_TIMESTAMPADD', (u, n, v) => timestampadd(u, n, v), [3]],
      ['MYSQL_EXTRACT', (u, v) => extractPart(u, v), [2]],
      ['MYSQL_GC_ENCODE', v => {
        if (isNull(v)) return null;
        return 'B' + base64Encode(asText(v));
      }, [1]],
      ['MYSQL_GC_DECODE', v => {
        const s = asText(v);
        if (s === null) return null;
        if (!s.startsWith('B')) return s;
        const bytes = base64Decode(s.slice(1));
        return bytes === null ? null : decodeBytes(bytes);
      }, [1]],
      ['MYSQL_GC_JOIN', (joined, sep) => {
        if (isNull(joined)) return null;
        const s = asText(joined);
        if (s === '') return '';
        /* Az SQLite a group_concat-nél a vesszőt használja elválasztóként; a
           kódolt értékek nem tartalmazhatnak vesszőt, ezért biztonságos a bontás. */
        const parts = s.split(',');
        const decoded = parts.map(p => {
          if (!p.startsWith('B')) return p;
          const bytes = base64Decode(p.slice(1));
          return bytes === null ? p : decodeBytes(bytes);
        });
        return decoded.join(isNull(sep) ? ',' : asText(sep));
      }, [2]]
    ];
    for (const [name, fn, arity] of helpers) {
      /* Ugyanaz a név szerinti csapda, mint a scalars-nál: egy névhez csak
         EGY hívásszál regisztrálható, ezért több aritásnál változó alakot
         használunk. */
      const list = arity.map(a => a === '*' ? -1 : a);
      const single = list.length === 1 ? list[0] : -1;
      try {
        db.create_function(name, single === -1 ? variadicCallback(fn) : fixedCallback(fn, single));
      } catch (e) { /* tovább */ }
    }

    /* Aggregátumok. A SUM/AVG/MIN/MAX/COUNT/GROUP_CONCAT beépített SQLite-
       függvényeket NEM írjuk felül: azok MySQL-kompatibilisek (a GROUP_CONCAT
       DISTINCT-et és ORDER BY-t is ismer). Csak az SQLite-ban hiányzókat adjuk. */
    const aggregates = {
      STD: stddevAgg(false),
      STDDEV: stddevAgg(false),
      STDDEV_POP: stddevAgg(true),
      STDDEV_SAMP: stddevAgg(false),
      VARIANCE: varianceAgg(false),
      VAR_POP: varianceAgg(true),
      VAR_SAMP: varianceAgg(false),
      BIT_AND: bitAgg((a, b) => (a === null ? b : a & b), null),
      BIT_OR: bitAgg((a, b) => (a === null ? b : a | b), null),
      BIT_XOR: bitAgg((a, b) => (a === null ? b : a ^ b), null),
      JSON_ARRAYAGG: JSON_ARRAYAGG,
      JSON_OBJECTAGG: JSON_OBJECTAGG
    };
    for (const [name, definition] of Object.entries(aggregates)) {
      try { db.create_aggregate(name, definition); } catch (e) { /* tovább */ }
    }

    /* LIKE felülírása Unicode-tudatosra. */
    try {
      const two = function (pattern, value) { return likeMatch(pattern, value, '\\'); };
      const three = function (pattern, value, escape) { return likeMatch(pattern, value, escape); };
      if (typeof db.create_function === 'function') {
        db.create_function('like', makeLikeCallback(two, 2));
        db.create_function('LIKE', makeLikeCallback(three, 3));
      }
    } catch (e) { /* a beépített LIKE marad */ }

    /* REGEXP / RLIKE operátor (x REGEXP 'minta'). */
    try {
      if (typeof db.create_function === 'function') {
        db.create_function('regexp', function (pattern, value) { return regexpLike(value, pattern); });
      }
    } catch (e) { /* a beépített REGEXP marad */ }

    defaultState.db = db;
    resetSchemaCache();
    try { ensureInformationSchema(db); } catch (e) { /* opcionális */ }
    return db;
  }

  function makeLikeCallback(fn, arity) {
    const wrapper = arity === 2 ? (a, b) => fn(a, b) : (a, b, c) => fn(a, b, c);
    return wrapper;
  }

  /* Az install(db) visszaadja a db-t, de a MySQL-parancsokat is kezeli. */
  function install(db) {
    if (!db) throw new Error('Az install(db) egy sql.js Database objektumot vár.');
    installFunctions(db);
    if (!db.__mysql9Patched) {
      const originalExec = db.exec.bind(db);
      const originalRun = db.run.bind(db);
      db.__mysql9OriginalExec = originalExec;
      db.__mysql9OriginalRun = originalRun;
      const needsPlanningRe = /(?:^|;)\s*(?:CREATE|DROP|ALTER)\s+(?:DATABASE|SCHEMA)\b|(?:^|;)\s*USE\s|(?:^|;)\s*(?:SHOW|DESCRIBE|DESC)\b|(?:^|;)\s*TRUNCATE\b|(?:^|;)\s*RENAME\s+TABLE\b|(?:^|;)\s*(?:GRANT|REVOKE|FLUSH|LOCK\s+TABLES)\b|(?:^|;)\s*CREATE\s+OR\s+REPLACE\s+(?:(?:ALGORITHM|DEFINER|SQL\s+SECURITY)\b[^;]*?\s)?VIEW\b|(?:^|;)\s*DROP\s+(?:TEMPORARY\s+)?(?:TABLE|VIEW)\b[^;]*,/i;
      db.exec = function (sql, params) {
        if (params !== undefined) return originalExec(sql, params);
        if (!needsPlanningRe.test(String(sql))) return originalExec(rewrite(sql));
        return execute(sql, db);
      };
      db.run = function (sql, params) {
        if (params !== undefined) return originalRun(rewrite(sql), params);
        if (!needsPlanningRe.test(String(sql))) return originalRun(rewrite(sql));
        execute(sql, db);
        return undefined;
      };
      db.__mysql9Patched = true;
    }
    return db;
  }

  /* =======================================================================
   * 13. Oktatási szabályellenőrzés
   * ---------------------------------------------------------------------
   * A MySQL szigorúbb, mint az SQLite: több hibát csendben lefuttat. Ezeket
   * itt fogjuk el, hogy a tanuló magyar magyarázatot kapjon.
   * Visszatérés: null vagy { type:'sql'|'logical', code, message, start, end }
   * ===================================================================== */

  function issue(type, code, message, token) {
    return { type, code, message, start: token ? token.start : 0, end: token ? token.end : 0 };
  }

  /* Egyszerű sémagyorsítótár a validatorhoz. */
  const schemaCache = new Map();
  function readTableInfo(db, table) {
    if (!db) return null;
    const key = String(table).toLowerCase();
    if (schemaCache.has(key)) return schemaCache.get(key);
    let info = null;
    const parts = String(table).split('.');
    const bare = parts.pop();
    const schema = parts.length ? parts.pop() : null;
    /* Az information_schema / sqlite_master / DUAL különleges: ne jelentsünk
       hiányzó táblát rájuk. */
    if (['dual', 'sqlite_master', 'information_schema'].includes(bare.toLowerCase())) {
      schemaCache.set(key, null);
      return null;
    }
    try {
      const args = schema ? JSON.stringify(bare) + ', ' + JSON.stringify(schema) : JSON.stringify(bare);
      const rows = db.exec('SELECT * FROM pragma_table_info(' + args + ')')[0];
      if (rows && rows.values.length) {
        info = {
          columns: new Set(rows.values.map(r => String(r[1]).toLowerCase())),
          primary: rows.values.filter(r => Number(r[5]) > 0).map(r => String(r[1]).toLowerCase())
        };
      }
    } catch (e) { info = null; }
    schemaCache.set(key, info);
    return info;
  }
  function resetSchemaCache() { schemaCache.clear(); }

  /* A lekérdezésben használt táblák (FROM / JOIN után). A WITH ... AS (...)
     által definiált CTE-neveket kihagyjuk. */
  function referencedTables(tokens) {
    const cteNames = new Set();
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].word !== 'WITH' && tokens[i].word !== ',') continue;
      let k = i + 1;
      if (tokens[k] && tokens[k].word === 'RECURSIVE') k++;
      if (!tokens[k] || !isAtomToken(tokens[k])) continue;
      let after = k + 1;
      if (tokens[after] && tokens[after].word === '(') {
        const close = pairIndex(tokens, after, 1, '(', ')');
        if (close < 0) continue;
        after = close + 1;
      }
      if (tokens[after] && tokens[after].word === 'AS') cteNames.add(unquoteName(tokens[k].text).toLowerCase());
    }
    const out = [];
    /* Csak olyan FROM/JOIN számít táblahivatkozásnak, amelyik egy
       SELECT-hez tartozik. A TRIM(BOTH 'x' FROM y), SUBSTRING(x FROM 2),
       EXTRACT(YEAR FROM d) alakokban a FROM függvényen belüli kulcsszó. */
    let depth = 0;
    const scopeDepth = new Set();
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.word === '(') { depth++; continue; }
      if (t.word === ')') { scopeDepth.delete(depth); depth = Math.max(0, depth - 1); continue; }
      if (t.word === 'SELECT') { scopeDepth.add(depth); continue; }
      if (t.word !== 'FROM' && t.word !== 'JOIN') continue;
      if (!scopeDepth.has(depth)) continue;
      const next = tokens[i + 1];
      if (!next) continue;
      if (next.word === '(') continue;
      if (!isAtomToken(next)) continue;
      let name = unquoteName(next.text).toLowerCase();
      /* Minősített név: information_schema.tables */
      if (tokens[i + 2] && tokens[i + 2].text === '.' && tokens[i + 3] && isAtomToken(tokens[i + 3])) {
        name += '.' + unquoteName(tokens[i + 3].text).toLowerCase();
        i += 2;
      }
      /* Táblaálnév átugrása (FROM t AS x / FROM t x). */
      if (tokens[i + 1] && tokens[i + 1].word === 'AS') i++;
      if (cteNames.has(name)) continue;
      if (!out.includes(name)) out.push(name);
    }
    return out;
  }

  /* SELECT- és záradékhatárok a legfelső szinten. */
  function analyzeScopes(tokens) {
    const scopes = [];
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.word === ')') { depth--; continue; }
      if (token.word === '(') { depth++; continue; }
      if (token.word !== 'SELECT' || depth !== 0) continue;
      const scope = { select: i, depth: 0, clauses: {}, end: tokens.length };
      for (let k = i + 1; k < tokens.length; k++) {
        const t = tokens[k];
        if (t.word === '(') { depth++; continue; }
        if (t.word === ')') { if (depth === 0) { scope.end = k; break; } depth--; continue; }
        if (depth !== 0) continue;
        if (['FROM', 'WHERE', 'HAVING', 'LIMIT', 'WINDOW'].includes(t.word) && scope.clauses[t.word] === undefined) scope.clauses[t.word] = k;
        if (['GROUP', 'ORDER'].includes(t.word) && tokens[k + 1] && tokens[k + 1].word === 'BY' && scope.clauses[t.word] === undefined) scope.clauses[t.word] = k;
        if (['UNION', 'INTERSECT', 'EXCEPT'].includes(t.word)) { scope.end = k; break; }
      }
      scopes.push(scope);
    }
    return scopes;
  }

  function clauseRange(scope, key, extraSkip) {
    const start = scope.clauses[key];
    if (start === undefined) return null;
    const after = Object.values(scope.clauses).filter(v => v > start);
    const end = Math.min(scope.end, after.length ? Math.min.apply(null, after) : scope.end);
    return { start: start + (extraSkip || 1), end };
  }

  /* A SELECT-lista elemei: kifejezés + esetleges álnév. */
  function selectItems(tokens, scope) {
    let start = scope.select + 1;
    while (start < tokens.length && ['DISTINCT', 'ALL', 'DISTINCTROW', 'DISTINCTROW', 'SQL_CALC_FOUND_ROWS',
      'SQL_NO_CACHE', 'SQL_CACHE', 'HIGH_PRIORITY', 'STRAIGHT_JOIN'].includes(tokens[start].word)) start++;
    const end = scope.clauses.FROM !== undefined ? scope.clauses.FROM
      : (scope.clauses.WHERE !== undefined ? scope.clauses.WHERE : scope.end);
    const ranges = [];
    let depth = 0, partStart = start;
    for (let i = start; i < end; i++) {
      const t = tokens[i];
      if (t.word === '(') depth++;
      else if (t.word === ')') depth--;
      else if (t.word === ',' && depth === 0) {
        ranges.push({ start: partStart, end: i });
        partStart = i + 1;
      }
    }
    if (partStart < end) ranges.push({ start: partStart, end });

    return ranges.map(range => {
      let alias = null;
      const last = tokens[range.end - 1];
      const before = tokens[range.end - 2];
      if (last && before && before.word === 'AS' && isAtomToken(last)) {
        alias = unquoteName(last.text).toLowerCase();
        range = { start: range.start, end: range.end - 2 };
      } else if (last && before && !['.', 'COLLATE'].includes(before.word) &&
        isAtomToken(last) && (isAtomToken(before) || before.word === ')' || before.word === 'END') &&
        last.start > before.end) {
        alias = unquoteName(last.text).toLowerCase();
        range = { start: range.start, end: range.end - 1 };
      }
      return { start: range.start, end: range.end, alias };
    });
  }

  function isAggregateWord(word) {
    return ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'GROUP_CONCAT', 'STD', 'STDDEV', 'STDDEV_POP', 'STDDEV_SAMP',
      'VARIANCE', 'VAR_POP', 'VAR_SAMP', 'BIT_AND', 'BIT_OR', 'BIT_XOR', 'JSON_ARRAYAGG', 'JSON_OBJECTAGG'].includes(word);
  }

  /* Kifejezésen belüli összesítők, hivatkozások, szubkveriek. */
  function isLiteralToken(token) {
    if (!token) return false;
    const text = String(token.text);
    if (/^'(?:[^']|'')*'$/.test(text)) return true;
    if (/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) return true;
    if (/^0x[0-9a-f]+$/i.test(text)) return true;
    if (/^x'[0-9a-f]*'$/i.test(text)) return true;
    return false;
  }

  function inspectExpression(tokens, start, end) {
    const refs = [], aggregates = [];
    let depth = 0;
    for (let i = start; i < end; i++) {
      const t = tokens[i];
      if (t.word === '(') {
        if (tokens[i + 1] && tokens[i + 1].word === 'SELECT') {
          const close = pairIndex(tokens, i, 1, '(', ')');
          if (close > 0) { i = close; continue; }
        }
        depth++;
        continue;
      }
      if (t.word === ')') { depth--; continue; }
      if (isAggregateWord(t.word) && tokens[i + 1] && tokens[i + 1].word === '(') {
        const close = pairIndex(tokens, i + 1, 1, '(', ')');
        if (close > 0) {
          /* Ablakfüggvény: SUM(x) OVER (...) — ez nem csoportosító összesítő. */
          if (tokens[close + 1] && tokens[close + 1].word === 'OVER') {
            i = close;
            continue;
          }
          aggregates.push({ name: t.word, start: i, end: close });
          i = close;
          continue;
        }
      }
      if (!isAtomToken(t)) continue;
      /* Literálok (szám, szöveg, backtickes konstans) nem oszlophivatkozások. */
      if (isLiteralToken(t)) continue;
      if (tokens[i - 1] && tokens[i - 1].word === 'COLLATE') continue;
      if (tokens[i + 1] && tokens[i + 1].word === '(') continue;       /* függvénynév */
      if (tokens[i + 1] && tokens[i + 1].word === '.' && isAtomToken(tokens[i + 2])) {
        refs.push({ name: unquoteName(tokens[i + 2].text).toLowerCase(), qualifier: unquoteName(t.text).toLowerCase(), index: i });
        i += 2;
        continue;
      }
      if (tokens[i - 1] && tokens[i - 1].word === '.') continue;
      refs.push({ name: unquoteName(t.text).toLowerCase(), qualifier: null, index: i });
    }
    return { refs, aggregates };
  }

  /* Kommentek eltávolítása szövegkonstans-érzékenyen. */
  function removeComments(sql) {
    const source = String(sql);
    let out = '', cursor = 0;
    for (const token of tokenize(source)) {
      if (!(token.text.startsWith('--') || token.text.startsWith('#') || token.text.startsWith('/*'))) continue;
      out += source.slice(cursor, token.start) + ' ' + '\n'.repeat((token.text.match(/\n/g) || []).length);
      cursor = token.end;
    }
    return out + source.slice(cursor);
  }

  function validate(sql, db) {
    if (typeof sql !== 'string' || !sql.trim()) return issue('sql', 'EMPTY_QUERY', 'Először írj be egy SQL-lekérdezést.');
    const cleaned = removeComments(sql);
    const tokens = codeTokens(cleaned);
    if (!tokens.length) return issue('sql', 'EMPTY_QUERY', 'A megjegyzés mellé írj egy SQL-lekérdezést is.');
    if (/^SELECT\b/i.test(cleaned) === false && !/^\s*(?:WITH|VALUES)\b/i.test(cleaned)) {
      return validateDataStatement(cleaned, tokens, db);
    }

    /* Zárdójel-ellenőrzés. */
    let depth = 0;
    for (const t of tokens) {
      if (t.word === '(') depth++;
      if (t.word === ')') { depth--; if (depth < 0) return issue('sql', 'UNEXPECTED_PARENTHESIS', 'Ehhez a záró zárójelhez nem tartozik nyitó zárójel.', t); }
    }
    if (depth > 0) return issue('sql', 'UNCLOSED_PARENTHESIS', 'A nyitó zárójelhez hiányzik a záró párja.');
    if (/'/.test(cleaned.replace(/'(?:''|[^'])*'/g, ''))) return issue('sql', 'UNTERMINATED_QUOTE', 'Az idézőjeles szöveg nincs lezárva.');

    /* Gyakori logikai csapdák (a régi mysql-compat.js-ből). */
    if (/\b(?:SUBSTRING|SUBSTR|MID)\s*\(\s*(?:'[^']*'|`[^`]+`|[\w$.]+)\s*,\s*0\s*[,)]/i.test(cleaned)) {
      return issue('logical', 'SUBSTRING_ZERO',
        'A MySQL-ben a szöveg pozíciója 1-től indul, ezért a 0 kezdőpozíció üres eredményt ad. Az első karakterhez 1-et írj.');
    }
    if (/\bFORMAT\s*\([^()]*\)\s*(?:>=|<=|>|<|=)\s*-?\d/i.test(cleaned)) {
      return issue('logical', 'FORMAT_COMPARISON',
        'A FORMAT() szöveget ad vissza, ezért számként nem hasonlítható össze. A WHERE feltételben a nyers számértéket használd.');
    }

    const scopes = analyzeScopes(tokens);
    for (const scope of scopes) {
      const problem = validateScope(cleaned, tokens, scope, db);
      if (problem) return problem;
    }
    return null;
  }

  function validateScope(sql, tokens, scope, db) {
    const items = selectItems(tokens, scope);
    const tables = referencedTables(tokens);
    const tableInfo = tables.map(t => readTableInfo(db, t)).filter(Boolean);
    const anyUnknownSource = tables.length > 0 && tables.some(t => !readTableInfo(db, t));

    /* 1) Összesítő a WHERE-ben. */
    const where = clauseRange(scope, 'WHERE');
    if (where) {
      const info = inspectExpression(tokens, where.start, where.end);
      if (info.aggregates.length) {
        return issue('sql', 'AGGREGATE_IN_WHERE',
          'Az összesítő függvény nem használható a WHERE záradékban. A sorokat WHERE-rel, a csoportosított eredményt HAVING-gel szűrd.', tokens[info.aggregates[0].start]);
      }
      /* 2) SELECT-álnév a WHERE-ben. */
      for (const item of items) {
        if (!item.alias) continue;
        const used = info.refs.find(r => r.name === item.alias && !r.qualifier);
        if (!used) continue;
        if (tables.length && tableInfo.length && tableInfo.some(i => i.columns.has(item.alias))) continue;
        if (anyUnknownSource) continue;
        return issue('sql', 'ALIAS_IN_WHERE',
          'A(z) „' + item.alias + '” SELECT-álnév ugyanennek a lekérdezésnek a WHERE részében még nem használható: a WHERE előbb fut le, mint hogy az álnév létrejönne. Írd ki a teljes kifejezést a WHERE-be.', tokens[used.index]);
      }
    }

    /* 3) ORDER BY szövegkonstans. */
    const order = clauseRange(scope, 'ORDER', 2);
    if (order) {
      let depth2 = 0, partStart = order.start;
      for (let i = order.start; i <= order.end; i++) {
        const t = tokens[i];
        if (t && t.word === '(') depth2++;
        if (t && t.word === ')') depth2--;
        if ((i === order.end || (t && t.word === ',' && depth2 === 0)) && i > partStart) {
          const relevant = tokens.slice(partStart, i).filter(x => !['ASC', 'DESC', 'NULLS', 'FIRST', 'LAST'].includes(x.word));
          if (relevant.length === 1 && relevant[0].text.startsWith("'")) {
            return issue('logical', 'CONSTANT_ORDER_BY',
              'Az ORDER BY itt állandó szövegre rendez, ami nem hat a sorrendre. Ha oszlopnevet vagy álnevet szeretnél, írj csupasz nevet vagy backticket.', relevant[0]);
          }
          partStart = i + 1;
        }
      }
    }

    /* 4) Aggregált és nem aggregált mező keverése GROUP BY nélkül. */
    const group = clauseRange(scope, 'GROUP', 2);
    const having = clauseRange(scope, 'HAVING');
    const infos = items.map(item => inspectExpression(tokens, item.start, item.end));
    const hasAggregate = infos.some(i => i.aggregates.length) || (having && inspectExpression(tokens, having.start, having.end).aggregates.length);
    if (!hasAggregate) return validateUnknownTable(tokens, tables, db);

    const groupRefs = [];
    if (group) {
      let depth2 = 0, partStart = group.start;
      const parts = [];
      for (let i = group.start; i <= group.end; i++) {
        const t = tokens[i];
        if (t && t.word === '(') depth2++;
        if (t && t.word === ')') depth2--;
        if ((i === group.end || (t && t.word === ',' && depth2 === 0)) && i >= partStart) {
          parts.push({ start: partStart, end: i });
          partStart = i + 1;
        }
      }
      for (const part of parts) {
        const span = tokens.slice(part.start, part.end)
          .filter(t => !['ASC', 'DESC', 'NULLS', 'FIRST', 'LAST'].includes(t.word))
          .filter(t => t.text !== ';' && t.text !== ',');
        if (!span.length) continue;
        /* GROUP BY sorszám (pl. GROUP BY 1): a SELECT-lista adott elemére utal. */
        if (span.length === 1 && /^\d+$/.test(span[0].text)) {
          const pos = parseInt(span[0].text, 10);
          if (pos >= 1 && pos <= infos.length) groupRefs.push(...infos[pos - 1].refs);
          continue;
        }
        const refs = inspectExpression(tokens, part.start, part.end).refs;
        /* GROUP BY álnév (pl. GROUP BY k): a SELECT-lista álnévhez tartozó
           kifejezés csoportosít, nem egy k nevű oszlop. A valódi oszlopnév
           elsőbbséget élvez, ahogy a MySQL-ben is. */
        if (refs.length === 1 && !refs[0].qualifier) {
          const aliasIndex = items.findIndex(it => it.alias && it.alias === refs[0].name);
          const realColumn = tableInfo.some(i => i.columns.has(refs[0].name));
          if (aliasIndex >= 0 && !realColumn) {
            groupRefs.push(...infos[aliasIndex].refs);
            continue;
          }
        }
        groupRefs.push(...refs);
      }
    }
    /* A WHERE-ben fixált oszlopok is meghatározzák a csoportot. */
    if (where) {
      const info = inspectExpression(tokens, where.start, where.end);
      if (!info.refs.some(r => false)) {
        for (const ref of info.refs) {
          const usesOr = tokens.slice(where.start, where.end).some(t => t.word === 'OR');
          if (!usesOr) groupRefs.push(ref);
        }
      }
    }
    for (let i = 0; i < items.length; i++) {
      const info = infos[i];
      const free = info.refs.find(ref => !groupRefs.some(g => g.name === ref.name && (!g.qualifier || !ref.qualifier || g.qualifier === ref.qualifier)));
      if (!free) continue;
      if (anyUnknownSource) continue;
      return issue('sql', group ? 'UNGROUPED_COLUMN' : 'MIXED_AGGREGATE',
        group
          ? 'A(z) „' + free.name + '” oszlop nincs összesítve, és a GROUP BY sem határozza meg egyértelműen. Tedd be a GROUP BY-ba, vagy használj rá összesítő függvényt.'
          : 'Összesítő lekérdezésben a(z) „' + free.name + '” oszlop szabadon szerepel. A soronkénti kifejezést tedd az összesítő függvénybe, vagy használj GROUP BY-t.',
        tokens[free.index]);
    }
    return validateUnknownTable(tokens, tables, db);
  }

  /* Ismeretlen táblanév jelzése (az adatok panelen látszik a helyes név). */
  function validateUnknownTable(tokens, tables, db) {
    if (!db || !tables.length) return null;
    for (const name of tables) {
      if (readTableInfo(db, name)) continue;
      if (['dual', 'sqlite_master'].includes(name)) continue;
      if (name.startsWith('information_schema.')) continue;
      let idx = -1;
      for (let i = 1; i < tokens.length; i++) {
        if (!['FROM', 'JOIN'].includes(tokens[i - 1].word)) continue;
        let found = unquoteName(tokens[i].text);
        if (tokens[i + 1] && tokens[i + 1].text === '.' && tokens[i + 2]) {
          found += '.' + unquoteName(tokens[i + 2].text);
        }
        if (found.toLowerCase() !== name) continue;
        idx = i;
        break;
      }
      const shown = name.replace(/^information_schema\./, '');
      return issue('sql', 'UNKNOWN_TABLE',
        'A(z) „' + shown + '” tábla nem szerepel az adatbázisban. Ellenőrizd a nevét (a forrásadatok panelen látod a valódi táblaneveket).',
        idx >= 0 ? tokens[idx] : null);
    }
    return null;
  }

  function validateDataStatement(sql, tokens, db) {
    return null;
  }

    /* =======================================================================
   * 14. Szintaxiskiemelés
   * ---------------------------------------------------------------------
   * A tananyag oldalai .kw / .fn / .str / .num / .ident / .comment
   * osztályokat használnak, a gyökér elem pedig .mysql-sql.
   * ===================================================================== */

  const HP_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escText(value) { return String(value).replace(/[&<>"']/g, ch => HP_ESC[ch]); }

  const HIGHLIGHT_KEYWORDS = new Set((
    'SELECT FROM WHERE HAVING GROUP ORDER BY AS ON JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL USING ' +
    'LIMIT OFFSET ASC DESC DISTINCT DISTINCTROW ALL ANY SOME CASE WHEN THEN ELSE END AND OR NOT XOR IN IS ' +
    'LIKE RLIKE REGEXP BETWEEN UNION INTERSECT EXCEPT WITH RECURSIVE COLLATE ESCAPE DIV MOD FOR SEPARATOR ' +
    'BINARY OVER PARTITION ROWS RANGE GROUPS PRECEDING FOLLOWING CURRENT ROW UNBOUNDED NULLS FIRST LAST FILTER ' +
    'EXCLUDE TIES OTHERS WINDOW QUALIFY STRAIGHT_JOIN LATERAL ' +
    'INSERT INTO VALUES UPDATE SET DELETE REPLACE TRUNCATE CREATE TABLE DATABASE SCHEMA VIEW INDEX UNIQUE ' +
    'PRIMARY KEY FOREIGN REFERENCES CONSTRAINT CHECK DEFAULT AUTO_INCREMENT UNSIGNED ZEROFILL ENUM ' +
    'ALTER ADD COLUMN DROP MODIFY CHANGE RENAME TO IF EXISTS TEMPORARY TEMP ENGINE CHARSET CHARACTER ' +
    'SHOW TABLES COLUMNS DESCRIBE DESC EXPLAIN USE DATABASES STATUS VARIABLES WARNINGS GRANTS ' +
    'BEGIN START TRANSACTION COMMIT ROLLBACK SAVEPOINT RELEASE WORK LOCK UNLOCK TABLES ' +
    'INTERVAL LEADING TRAILING BOTH TRUE FALSE UNKNOWN NULL ' +
    'GRANT REVOKE FLUSH OPTIMIZE ANALYZE REPAIR CHECKSUM ' +
    'INT INTEGER TINYINT SMALLINT MEDIUMINT BIGINT DECIMAL NUMERIC FLOAT DOUBLE REAL BIT BOOL BOOLEAN ' +
    'VARCHAR CHAR NVARCHAR NCHAR TEXT TINYTEXT MEDIUMTEXT LONGTEXT BLOB TINYBLOB MEDIUMBLOB LONGBLOB ' +
    'DATE DATETIME TIMESTAMP TIME YEAR JSON'
  ).split(/\s+/));

  function highlight(sql) {
    const tokens = tokenize(String(sql == null ? '' : sql));
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const text = token.text;
      if (/^\s/.test(text)) { out.push(text); continue; }
      let cls = null;
      if (text.startsWith('--') || text.startsWith('#') || text.startsWith('/*')) cls = 'comment';
      else if (text[0] === "'" || text[0] === '"') cls = 'str';
      else if (text[0] === '`' || text[0] === '[') cls = 'ident';
      else if (/^(?:0x[\da-f]+|\d)/i.test(text)) cls = 'num';
      else if (HIGHLIGHT_KEYWORDS.has(token.word)) cls = 'kw';
      /* Csak név lehet függvénynév: a `*` (1 * 2) vagy a `(` nem. */
      else if (isIdentifierWord(text) && nextCodeIsParen(tokens, i)) cls = 'fn';
      out.push(cls ? '<span class="' + cls + '">' + escText(text) + '</span>' : escText(text));
    }
    return out.join('');
  }

  /* Csak akkor lehet függvénynév, ha a token valóban név (nem `*`, `(`, szám). */
  function isIdentifierWord(text) {
    return /^[\p{L}_][\p{L}\p{N}_$]*$/u.test(text);
  }

  function nextCodeIsParen(tokens, index) {
    for (let i = index + 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (isTrivia(t.text)) continue;
      return t.word === '(';
    }
    return false;
  }

  const highlightCss = '.mysql-sql{white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;font-family:Consolas,"SFMono-Regular",monospace}' +
    '.mysql-sql .kw{color:#3155a6;font-weight:700}.mysql-sql .fn{color:#7652a1}' +
    '.mysql-sql .str{color:#18754c}.mysql-sql .num{color:#a44d19}' +
    '.mysql-sql .ident{color:#315b72}.mysql-sql .comment{color:#67757d;font-style:italic}';

  /* =======================================================================
   * 15. Régi (mysql-compat.js) globális API — változatlanul működik
   * ===================================================================== */

  /* registerFunctions(db): függvények + LIKE + information_schema. */
  function registerFunctions(db) {
    if (!db) throw new Error('A registerFunctions(db) egy sql.js Database objektumot vár.');
    installFunctions(db);
    try { ensureInformationSchema(db); } catch (e) { /* opcionális */ }
    defaultState.db = db;
    return db;
  }

  /* preprocessSql(sql): MySQL -> SQLite szöveg (db.exec elé). */
  function preprocessSql(sql) {
    return rewrite(sql);
  }

  /* mysqlValidate(sql[, db]): null vagy {type, code, message, start, end}. */
  function mysqlValidate(sql, db) {
    return validate(sql, db || defaultState.db);
  }

  /* Alias a régi névre. */
  function sqlHighlight(sql) { return highlight(sql); }

  /* =======================================================================
   * 16. Publikus felület
   * ===================================================================== */

  const api = {
    version: VERSION,
    /* új, ajánlott API */
    install: install,
    rewrite: rewrite,
    validate: validate,
    highlight: highlight,
    highlightCss: highlightCss,
    execute: execute,
    planStatements: planStatements,
    getState: () => defaultState,
    convertType: convertType,
    /* régi, kompatibilis API */
    registerFunctions: registerFunctions,
    preprocessSql: preprocessSql,
    mysqlValidate: mysqlValidate,
    sqlHighlight: sqlHighlight,
    /* segédek, ha valakinek kell */
    functions: scalars.map(s => s.name),
    esc: escText
  };

  return api;
});
