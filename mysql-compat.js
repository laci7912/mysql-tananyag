/*!
 * mysql-compat.js — MySQL 9 kompatibilitási réteg sql.js (SQLite / WebAssembly) fölé
 * ============================================================================
 * Az sql.js SQLite-ot futtat a böngészőben, ezért sok MySQL-függvény vagy
 * hiányzik, vagy másképp viselkedik. Ez a fájl azokat pótolja, illetve felülírja,
 * hogy a tananyag példái a valódi MySQL 9 eredményét adják.
 *
 * HASZNÁLAT
 * ---------
 * A HTML-ben a saját szkripted ELŐTT kell betölteni:
 *
 *   <script src="mysql-compat.js"><\/script>
 *
 * (A fenti példában a záró tag perjele escape-elve van, hogy ez a fájl
 *  gond nélkül BEÁGYAZHATÓ legyen egy HTML <script> blokkjába is.)
 *
 *   <script>
 *     const db = new SQL.Database();
 *     registerFunctions(db);                      // függvények bekötése
 *     db.exec(preprocessSql(sql));                // SQL átírás futtatás előtt
 *     const issue = mysqlValidate(sql);           // oktatási szabályellenőrzés
 *     hi.innerHTML = sqlHighlight(sql);           // szintaxiskiemelés
 *   <\/script>
 *
 * Klasszikus (nem module) szkript: a függvényei globálisak, fájlrendszerről
 * (file://) és webszerverről is működik, nincs szükség build eszközre.
 *
 * AMIT MYSQL 9 SZERINT MŰKÖDTET
 * -----------------------------
 *   ROUND          féltől ELFELÉ kerekít, negatív pontosság is (pl. -1 → tízesre)
 *   TRUNCATE       kerekítés nélküli levágás
 *   DIV, MOD, POW, POWER, SQRT, PI, CEIL, CEILING, FLOOR
 *   CONCAT         bármely NULL paraméter => NULL
 *   CONCAT_WS      NULL értékeket kihagyja; NULL elválasztó => NULL
 *   UPPER/LOWER    magyar ékezet helyesen (a beépített csak ASCII-t kezel)
 *   UCASE/LCASE    ugyanaz
 *   LENGTH         BÁJTban számol (a beépített karaktert számol)
 *   OCTET_LENGTH   ugyanaz, mint a LENGTH
 *   CHAR_LENGTH    karakterben (kódpontban) számol
 *   CHARACTER_LENGTH ugyanaz
 *   LEFT/RIGHT     hiányzó függvények, kódpont-alapú vágás
 *   SUBSTRING/SUBSTR/MID  1-alapú, negatív pos a végétől, pos=0 => '',
 *                  negatív vagy 0 hossz => ''
 *   LOCATE/INSTR   1-alapú KARAKTERpozíció, 0 = nincs találat
 *   REPLACE        minden előfordulás; üres keresett szöveg = változatlan
 *   TRIM/LTRIM/RTRIM  csak szóközt vág (a beépített több vezérlőkaraktert is)
 *   TRIM(... FROM ...)  a teljes MySQL alak, preprocesszálással
 *   REPEAT/LPAD/RPAD/REVERSE  MySQL szemantika (n<=0 => '', hosszabb = levágás)
 *   FORMAT         ezres tagolás + rögzített tizedesjegy (Intl alapú)
 *
 * FONTOS RÉSZLET A sql.js-ről
 * ---------------------------
 * A sql.js a regisztrált JavaScript-függvény `length` tulajdonságát használja
 * paraméterszámként. Egy (...args) => ... alakú függvény ezért NULLA paraméterű
 * függvényként jön létre, soha nem hívódik meg, és csendben a beépített
 * SQLite-függvény fut tovább. Ezért minden aritásra külön, fix paraméterszámú
 * burkolót regisztrálunk (regFn).
 *
 * Verzió: 1.0
 */

/* =========================================================================
 * Segédfüggvények – számok és szöveg
 * ========================================================================= */

function mysqlRound(x,d){if(x===null||x===undefined)return null;const n=Number(x);const dec=(d===undefined||d===null)?0:Number(d);if(!isFinite(n)||isNaN(dec))return n;const neg=n<0;const a=Math.abs(n);const shifted=Number(a.toPrecision(15)+'e'+dec);const r=Math.round(shifted);const back=Number(r+'e'+(-dec));return neg?-back:back;}
function truncate(x,d){if(x===null||d===null)return null;const f=Math.pow(10,Number(d));return Math.trunc(Number(x)*f)/f;}
const HU_LOCALE='hu-HU';
function cpArr(v){return Array.from(String(v));}
function utf8Length(v){return v===null?null:new TextEncoder().encode(String(v)).length;}
function mysqlSubstring(str,pos,len){if(str===null||pos===null||len===null)return null;const s=cpArr(str);const p=Number(pos);if(p===0)return '';let start;if(p>0)start=p-1;else{start=s.length+p;if(start<0)start=0;}if(start>=s.length)return '';if(len===undefined)return s.slice(start).join('');const L=Math.trunc(Number(len));if(!(L>=1))return '';return s.slice(start,start+L).join('');}
function mysqlPad(str,len,pad,left){if(str===null||len===null||pad===null)return null;const s=cpArr(str);const n=Math.trunc(Number(len));if(!(n>0))return '';if(s.length>=n)return s.slice(0,n).join('');const p=cpArr(pad);if(!p.length)return s.join('');let fill='';while(cpArr(fill).length<n-s.length)fill+=pad;fill=cpArr(fill).slice(0,n-s.length).join('');return left?fill+s.join(''):s.join('')+fill;}
function mysqlFormat(x,d,locale){if(x===null||d===null)return null;const dec=Math.max(0,Math.trunc(Number(d===undefined||d===null?0:d)));const loc=String(locale||'en_US').replace('_','-');let out;try{out=new Intl.NumberFormat(loc,{minimumFractionDigits:dec,maximumFractionDigits:dec,useGrouping:true}).format(Number(x));}catch(e){out=new Intl.NumberFormat('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec,useGrouping:true}).format(Number(x));}return out.replace(/[\u00A0\u202F]/g,' ');}
function mysqlTrim(str){return str===null?null:String(str).replace(/^ +| +$/g,'');}
function mysqlTrimDir(str,rem,mode){if(str===null||rem===null)return null;const r=String(rem);let v=String(str);if(!r)return v;const side=String(mode||'BOTH').toUpperCase();if(side==='LEADING'||side==='BOTH')while(v.startsWith(r))v=v.slice(r.length);if(side==='TRAILING'||side==='BOTH')while(v.endsWith(r))v=v.slice(0,v.length-r.length);return v;}

/* =========================================================================
 * Regisztráció az sql.js motorba
 * ========================================================================= */

const FN_ARITY={0:f=>()=>f(),1:f=>a=>f(a),2:f=>(a,b)=>f(a,b),3:f=>(a,b,c)=>f(a,b,c),4:f=>(a,b,c,d)=>f(a,b,c,d),5:f=>(a,b,c,d,e)=>f(a,b,c,d,e),6:f=>(a,b,c,d,e,g)=>f(a,b,c,d,e,g)};
function regFn(database,name,fn,arities){arities.forEach(n=>database.create_function(name,FN_ARITY[n](fn)));}
function registerFunctions(database){
 registerFunctionsMath(database);registerFunctionsText(database);
}
/* Matematikai függvények – MySQL 9 szemantikával. */
function registerFunctionsMath(database){
 regFn(database,'MOD',(x,y)=>x===null||y===null?null:Number(x)%Number(y),[2]);
 regFn(database,'POW',(x,y)=>x===null||y===null?null:Math.pow(Number(x),Number(y)),[2]);
 regFn(database,'POWER',(x,y)=>x===null||y===null?null:Math.pow(Number(x),Number(y)),[2]);
 regFn(database,'SQRT',x=>x===null?null:Math.sqrt(Number(x)),[1]);
 regFn(database,'PI',()=>Math.PI,[0]);
 regFn(database,'ROUND',(x,d)=>mysqlRound(x,d===undefined?0:d),[1,2]);
 regFn(database,'CEIL',x=>x===null?null:Math.ceil(Number(x)),[1]);
 regFn(database,'CEILING',x=>x===null?null:Math.ceil(Number(x)),[1]);
 regFn(database,'FLOOR',x=>x===null?null:Math.floor(Number(x)),[1]);
 regFn(database,'TRUNCATE',(x,d)=>truncate(x,d),[2]);
 regFn(database,'MYSQL_DIV',(x,y)=>x===null||y===null?null:Math.trunc(Number(x)/Number(y)),[2]);
}
/* Szövegfüggvények – MySQL 9 szemantikával. */
function registerFunctionsText(database){
 regFn(database,'CONCAT',(...a)=>a.some(v=>v===null)?null:a.map(String).join(''),[1,2,3,4,5,6]);
 regFn(database,'CONCAT_WS',(sep,...a)=>sep===null?null:a.filter(v=>v!==null).map(String).join(String(sep)),[2,3,4,5,6]);
 regFn(database,'UPPER',v=>v===null?null:String(v).toLocaleUpperCase(HU_LOCALE),[1]);
 regFn(database,'UCASE',v=>v===null?null:String(v).toLocaleUpperCase(HU_LOCALE),[1]);
 regFn(database,'LOWER',v=>v===null?null:String(v).toLocaleLowerCase(HU_LOCALE),[1]);
 regFn(database,'LCASE',v=>v===null?null:String(v).toLocaleLowerCase(HU_LOCALE),[1]);
 regFn(database,'LENGTH',utf8Length,[1]);
 regFn(database,'OCTET_LENGTH',utf8Length,[1]);
 regFn(database,'CHAR_LENGTH',v=>v===null?null:cpArr(v).length,[1]);
 regFn(database,'CHARACTER_LENGTH',v=>v===null?null:cpArr(v).length,[1]);
 regFn(database,'LEFT',(v,n)=>v===null||n===null?null:cpArr(v).slice(0,Math.max(0,Math.trunc(Number(n)))).join(''),[2]);
 regFn(database,'RIGHT',(v,n)=>{if(v===null||n===null)return null;const k=Math.max(0,Math.trunc(Number(n)));return k===0?'':cpArr(v).slice(-k).join('');},[2]);
 regFn(database,'SUBSTRING',mysqlSubstring,[2,3]);
 regFn(database,'SUBSTR',mysqlSubstring,[2,3]);
 regFn(database,'MID',mysqlSubstring,[2,3]);
 regFn(database,'LOCATE',(sub,str,pos)=>{if(sub===null||str===null)return null;const from=pos===undefined?0:Math.max(0,Math.trunc(Number(pos))-1);const i=String(str).indexOf(String(sub),from);return i<0?0:cpArr(String(str).slice(0,i)).length+1;},[2,3]);
 regFn(database,'INSTR',(str,sub)=>{if(str===null||sub===null)return null;const i=String(str).indexOf(String(sub));return i<0?0:cpArr(String(str).slice(0,i)).length+1;},[2]);
 regFn(database,'REPLACE',(str,from,to)=>str===null||from===null||to===null?null:String(str).split(String(from)).join(String(to)),[3]);
 regFn(database,'TRIM',mysqlTrim,[1]);
 regFn(database,'LTRIM',v=>v===null?null:String(v).replace(/^ +/,''),[1]);
 regFn(database,'RTRIM',v=>v===null?null:String(v).replace(/ +$/,''),[1]);
 regFn(database,'MYSQL_TRIM_DIR',mysqlTrimDir,[3]);
 regFn(database,'REPEAT',(v,n)=>v===null||n===null?null:String(v).repeat(Math.max(0,Math.trunc(Number(n)))),[2]);
 regFn(database,'LPAD',(v,n,p)=>mysqlPad(v,n,p,true),[3]);
 regFn(database,'RPAD',(v,n,p)=>mysqlPad(v,n,p,false),[3]);
 regFn(database,'REVERSE',v=>v===null?null:cpArr(v).reverse().join(''),[1]);
 regFn(database,'FORMAT',(v,d,loc)=>mysqlFormat(v,d===undefined?0:d,loc),[2,3]);
}

/* =========================================================================
 * SQL előfeldolgozás – a SQLite által nem ismert MySQL-szintaxis átírása.
 * Futtatás előtt minden lekérdezésen át kell engedni:
 *     db.exec(preprocessSql(sql))
 * ========================================================================= */


/* A teljes SQL-átírás: a `x DIV y` operátor (MYSQL_DIV) és a
   TRIM(... FROM ...) alak. Minden lekérdezést ezen keresztül kell futtatni. */
function preprocessSql(sql){const div=sql.replace(/(\([^()]+\)|`[^`]+`|-?\d+(?:\.\d+)?)\s+DIV\s+(\([^()]+\)|`[^`]+`|-?\d+(?:\.\d+)?)/gi,'MYSQL_DIV($1,$2)');return preprocessTrim(div);}

/* A MySQL `TRIM([LEADING|TRAILING|BOTH] x FROM y)` alakját MYSQL_TRIM_DIR()
   hívássá alakítja. Literál és backtickes azonosító argumentumra működik;
   oszlopnévre nem, mert a mintaillesztés regexen alapul. */
function preprocessTrim(q){return q.replace(/\bTRIM\s*\(\s*(?:(LEADING|TRAILING|BOTH)\s+)?('(?:[^']|'')*'|`[^`]+`)\s+FROM\s+('(?:[^']|'')*'|`[^`]+`)\s*\)/gi,(m,mode,rem,src)=>"MYSQL_TRIM_DIR("+src+","+rem+",'"+(mode||'BOTH').toUpperCase()+"')");}

/* =========================================================================
 * Oktatási szabályellenőrzés – tipikus kezdőhibák felismerése futtatás előtt,
 * hogy a tanuló magyar magyarázatot kapjon a nyers SQLite-hiba helyett.
 * Visszatérés: null, vagy {type:'sql'|'logical', message:string}
 * ========================================================================= */

function mysqlValidate(sql){const s=sql.replace(/--.*$/gm,' ').replace(/\s+/g,' ').trim();const w=(s.match(/\bWHERE\b([\s\S]*?)(?:\bORDER\s+BY\b|\bGROUP\s+BY\b|\bLIMIT\b|$)/i)||[])[1]||'';if(/\b(SUM|AVG|MIN|MAX|COUNT)\s*\(/i.test(w))return {type:'sql',message:'Az összesítő függvény nem használható a WHERE záradékban.'};const aliases=[...s.matchAll(/\bAS\s+`([^`]+)`/gi)].map(m=>m[1]);for(const a of aliases){if(new RegExp('`'+a.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'`','i').test(w))return {type:'sql',message:'A SELECT-listában létrehozott álnév nem használható ugyanennek a lekérdezésnek a WHERE részében.'};}if(/\bORDER\s+BY\s+'[^']+'/i.test(s))return {type:'logical',message:'Az ORDER BY aposztrófos szövegkonstanst kapott, nem oszlopazonosítót. Használj backticket.'};if(/\b(SUBSTRING|SUBSTR|MID)\s*\(\s*(?:'[^']*'|`[^`]+`)\s*,\s*0\s*[,)]/i.test(s))return {type:'logical',message:'A MySQL-ben a szöveg pozíciója 1-től indul, ezért a 0 kezdőpozíció üres eredményt ad. Az első karakterhez 1-et írj.'};if(/\bFORMAT\s*\([^()]*\)\s*(?:>=|<=|>|<|=)\s*-?\d/i.test(s))return {type:'logical',message:'A FORMAT() szöveget ad vissza, ezért számként nem hasonlítható össze. A WHERE feltételben a nyers számértéket használd.'};if(/\b(SUM|AVG|MIN|MAX|COUNT)\s*\([^)]*\)\s*[+*\/-]\s*\([^)]*`[^`]+`[^)]*\)/i.test(s)&&!/\bGROUP\s+BY\b/i.test(s))return {type:'sql',message:'Az összesítő függvény eredménye mellett nem használható nem összesített mező GROUP BY nélkül. Tedd a teljes soronkénti kifejezést az összesítő függvény belsejébe.'};if(/\bSELECT\b[\s\S]*?\b(SUM|AVG|MIN|MAX|COUNT)\s*\([^)]*\)[\s\S]*?\bFROM\b/i.test(s)&&!/\bGROUP\s+BY\b/i.test(s)){const select=(s.match(/\bSELECT\b([\s\S]*?)\bFROM\b/i)||[])[1]||'';const stripped=select.replace(/\b(SUM|AVG|MIN|MAX|COUNT)\s*\([^)]*\)/gi,'').replace(/\bROUND\s*\([^)]*\)/gi,'').replace(/\bAS\s+`[^`]+`/gi,'').replace(/[\s,0-9.+*()'-]/g,'');if(/`[^`]+`|\b[a-z_][a-z0-9_]*\b/i.test(stripped))return {type:'sql',message:'Aggregált lekérdezésben GROUP BY nélkül nem szerepelhet nem összesített oszlop a SELECT-listában.'};}return null;}

/* =========================================================================
 * Szintaxiskiemelés a tananyag CSS-osztályaival:
 *   .kw (kulcsszó), .fn (függvény), .str (szöveg), .num (szám),
 *   .ident (backtickes azonosító), .comment (megjegyzés)
 * ========================================================================= */

/* Saját HTML-escape, hogy a fájl önállóan is működjön, az oldal esc()
   függvényétől függetlenül. */
function mysqlEsc(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function sqlHighlight(s){const kw=new Set(['SELECT','FROM','AS','WHERE','ORDER','BY','ASC','DESC','DISTINCT','IS','NOT','NULL','LIMIT','GROUP','HAVING','AND','OR','DIV','LIKE','BETWEEN','IN','LEADING','TRAILING','BOTH']);const fn=new Set(['ABS','MOD','POW','POWER','SQRT','PI','ROUND','CEIL','CEILING','FLOOR','TRUNCATE','SUM','AVG','MIN','MAX','COUNT','CONCAT','CONCAT_WS','UPPER','UCASE','LOWER','LCASE','LENGTH','OCTET_LENGTH','CHAR_LENGTH','CHARACTER_LENGTH','LEFT','RIGHT','SUBSTRING','SUBSTR','MID','LOCATE','INSTR','REPLACE','TRIM','LTRIM','RTRIM','REPEAT','LPAD','RPAD','REVERSE','FORMAT']);const token=/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|--[^\n]*|\b(?:SELECT|FROM|AS|WHERE|ORDER|BY|ASC|DESC|DISTINCT|IS|NOT|NULL|LIMIT|GROUP|HAVING|AND|OR|DIV|LIKE|BETWEEN|IN|LEADING|TRAILING|BOTH)\b|\b(?:ABS|MOD|POW|POWER|SQRT|PI|ROUND|CEIL|CEILING|FLOOR|TRUNCATE|SUM|AVG|MIN|MAX|COUNT|CONCAT|CONCAT_WS|UPPER|UCASE|LOWER|LCASE|LENGTH|OCTET_LENGTH|CHAR_LENGTH|CHARACTER_LENGTH|LEFT|RIGHT|SUBSTRING|SUBSTR|MID|LOCATE|INSTR|REPLACE|TRIM|LTRIM|RTRIM|REPEAT|LPAD|RPAD|REVERSE|FORMAT)\b(?=\s*\()|\b\d+(?:\.\d+)?\b/gi;return String(s).replace(token,m=>{const u=m.toUpperCase(),e=mysqlEsc(m);if(m.startsWith('--'))return '<span class="comment">'+e+'</span>';if(m[0]==="'"||m[0]==="\"")return '<span class="str">'+e+'</span>';if(m[0]==='`')return '<span class="ident">'+e+'</span>';if(fn.has(u))return '<span class="fn">'+e+'</span>';if(kw.has(u))return '<span class="kw">'+e+'</span>';return '<span class="num">'+e+'</span>';});}
