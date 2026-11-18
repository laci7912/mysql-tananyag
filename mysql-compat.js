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
 /* A validátor a sémából tudja megkülönböztetni a valódi oszlopnevet a puszta
    álnévtől (pl. `FORMAT(`ar`,2) AS `ar`` a `italok` táblán nem hiba, mert a
    WHERE a valódi `ar` oszlopot látja). Ezért minden inicializáláskor frissítjük. */
 MYSQL_DB=database;mysqlRegisterSchema(database);
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
 *
 * FONTOS: a sql.js (SQLite) megenged olyat, amit a MySQL nem. A legfontosabb
 * példa a SELECT-álnév használata a WHERE-ben:
 *
 *     SELECT `nev`, `netto` * (1 + `afa`) AS `brutto`   -- MySQL: 1054 hiba
 *     FROM `termekek` WHERE `brutto` > 400;             -- SQLite: lefut!
 *
 * A MySQL-ben a WHERE előbb fut le, mint hogy az álnév létrejönne, ezért ott
 * "Unknown column in 'where clause'" a válasz. Mivel az SQLite csendben
 * lefuttatja, a hibát itt kell elkapni – különben a tanuló rossz SQL-t tanul.
 * ========================================================================= */

/* A regisztrált adatbázis és a belőle kiolvasott séma. A sémára azért van
   szükség, hogy meg tudjuk különböztetni a valódi oszlopnevet a puszta
   álnévtől: a MySQL a WHERE-ben a valódi oszlopot használja, ha van ilyen. */
let MYSQL_DB=null;
let MYSQL_SCHEMA=null;

function mysqlRegisterSchema(database){
  const src=database||MYSQL_DB;
  const map=new Map();
  try{
    if(src){
      const r=src.exec("SELECT name FROM sqlite_master WHERE type IN ('table','view')")[0];
      if(r)r.values.forEach(row=>{
        const raw=String(row[0]), cols=new Set();
        try{
          const info=src.exec('PRAGMA table_info(`'+raw.replace(/`/g,'``')+'`)')[0];
          if(info)info.values.forEach(c=>cols.add(String(c[1]).toLowerCase()));
        }catch(e){}
        map.set(raw.toLowerCase(),cols);
      });
    }
  }catch(e){}
  MYSQL_SCHEMA=map.size?map:null;
  return MYSQL_SCHEMA;
}

/* Azok a szavak, amelyeket soha nem tekintünk oszlopnévnek. */
const MYSQL_SQL_WORDS=new Set(['and','or','not','is','null','like','between','in','exists','where','order','by','group','having','limit','asc','desc','true','false','div','mod','binary','collate','case','when','then','else','end','distinct','all','any','some','on','using','join','inner','left','right','full','cross','union','select','from','as','set','interval','escape','regexp','rlike','xor','values','into','dual']);

/* A WHERE záradék a szövegben elfoglalt HELYÉVEL együtt, hogy a lekérdezés
   többi részét pontosan le tudjuk választani (a szövegkonstansok miatt
   a keresés-szövegre nem lehet támaszkodni). */
function mysqlWhereClause(s){
  const m=/\bWHERE\b([\s\S]*?)(?:\bGROUP\s+BY\b|\bHAVING\b|\bORDER\s+BY\b|\bLIMIT\b|$)/i.exec(s);
  if(!m)return {text:'',from:-1,to:-1};
  const from=m.index+m[0].length-m[1].length;
  return {text:m[1],from:from,to:from+m[1].length};
}

/* A SELECT-lista szövege (a legelső SELECT és a hozzá tartozó FROM között). */
function mysqlSelectList(s){return (s.match(/\bSELECT\b([\s\S]*?)\bFROM\b/i)||[])[1]||'';}

/* A szövegkonstansok kivétele, hogy a bennük lévő szavak ne számítsanak
   azonosítónak (pl. WHERE `nev` = 'brutto' esetén ne legyen téves találat). */
function mysqlStripStrings(t){return String(t||'').replace(/'(?:[^'\\]|\\.|'')*'/g,' ');}

/* Azonosítók egy szövegrészben – backtickes és csupasz alak is, kisbetűsen. */
function mysqlIdentifiers(text){
  const out=[];
  mysqlStripStrings(text).replace(/`([^`]+)`|[A-Za-z_$][\w$]*/g,(m,bt)=>{out.push(String(bt===undefined?m:bt).toLowerCase());return m;});
  return out;
}

/* A lekérdezésben szereplő táblák nevei (FROM / JOIN után). */
function mysqlReferencedTables(s){
  const out=[], re=/\b(?:FROM|JOIN)\s+(`[^`]+`|[A-Za-z_$][\w$]*)/gi;
  let m;
  while((m=re.exec(s))){
    const n=m[1].replace(/`/g,'').toLowerCase();
    if(!MYSQL_SQL_WORDS.has(n)&&!out.includes(n))out.push(n);
  }
  return out;
}

/* A SELECT-listában létrehozott MEZŐálnevek. A táblaálneveket (FROM / JOIN
   után) kihagyjuk, mert azok a WHERE-ben jogosan használhatók. */
function mysqlColumnAliases(s){
  const names=new Set(), list=mysqlSelectList(s), re=/\bAS\s+(`[^`]+`|[A-Za-z_$][\w$]*)/gi;
  let m;
  while((m=re.exec(list)))names.add(m[1].replace(/`/g,'').toLowerCase());
  if(!names.size)return [];
  mysqlReferencedTables(s).forEach(t=>names.delete(t));
  return [...names];
}

/* Igaz, ha a név valódi oszlop a lekérdezésben szereplő valamelyik táblában.
   Ilyenkor a MySQL a WHERE-ben az OSZLOPOT használja, nem az álnevet, tehát
   nincs hiba (pl. `SELECT FORMAT(`ar`,2) AS `ar` FROM `italok` WHERE `ar`>100`). */
function mysqlIsRealColumnOf(s,name){
  if(!MYSQL_SCHEMA&&MYSQL_DB)mysqlRegisterSchema(MYSQL_DB);
  if(!MYSQL_SCHEMA)return false;
  return mysqlReferencedTables(s).some(t=>{const c=MYSQL_SCHEMA.get(t);return !!(c&&c.has(name));});
}

/* MySQL-hiba, amit az SQLite nem jelez: SELECT-álnév a WHERE-ben.
   Csak akkor jelezzük, ha a név tényleg álnevű: a lekérdezés más részén
   (a WHERE-n és az AS-fejlécen kívül) nem szerepel valódi oszlopként.
   Így a `SELECT `nev` AS `nev` ... WHERE `nev` = 'x'` eset nem téves riasztás. */
function mysqlAliasInWhere(s){
  const wc=mysqlWhereClause(s);
  if(!wc.text)return null;
  /* Altáblakérdésnél és UNION-nál a záradékok hatóköre különválik, a puszta
     szövegelemzés itt téves riasztást adhatna, ezért ilyenkor nem ellenőrzünk.
     A tananyag egyik mintája sem használ ilyet. */
  if(/\(\s*SELECT\b/i.test(s)||/\bUNION\b/i.test(s))return null;
  const aliases=mysqlColumnAliases(s);
  if(!aliases.length)return null;
  // a `t`.`oszlop` és a t.oszlop alak mindig valódi oszlop, ezért kivesszük
  const bare=mysqlStripStrings(wc.text)
    .replace(/`[^`]*`\s*\.\s*(?:`[^`]*`|[A-Za-z_$][\w$]*)/g,' ')
    .replace(/[A-Za-z_$][\w$]*\s*\.\s*(?:`[^`]*`|[A-Za-z_$][\w$]*)/g,' ');
  const used=new Set(mysqlIdentifiers(bare).filter(id=>!MYSQL_SQL_WORDS.has(id)));
  if(!used.size)return null;
  // a lekérdezés WHERE-n kívüli része, az AS-fejlécek nélkül
  const rest=mysqlStripStrings(s.slice(0,wc.from)+' '+s.slice(wc.to))
    .replace(/\bAS\s+(?:`[^`]+`|[A-Za-z_$][\w$]*)/gi,' ');
  const real=new Set(mysqlIdentifiers(rest));
  for(const a of aliases){
    if(!used.has(a))continue;
    if(real.has(a))continue;               // máshol valódi oszlopként szerepel
    if(mysqlIsRealColumnOf(s,a))continue;  // van ilyen oszlop a forrástáblában
    return {type:'sql',message:'A SELECT-listában létrehozott álnév nem használható ugyanennek a lekérdezésnek a WHERE részében. A WHERE ugyanis előbb fut le, mint hogy az álnév létrejönne (MySQL: 1054 ismeretlen oszlop). Írd ki a teljes kifejezést a WHERE feltételébe.'};
  }
  return null;
}

function mysqlValidate(sql){
  const s=String(sql||'').replace(/--.*$/gm,' ').replace(/\s+/g,' ').trim();
  const w=mysqlWhereClause(s).text;
  if(/\b(SUM|AVG|MIN|MAX|COUNT)\s*\(/i.test(w))return {type:'sql',message:'Az összesítő függvény nem használható a WHERE záradékban.'};
  const aliasIssue=mysqlAliasInWhere(s);
  if(aliasIssue)return aliasIssue;
  if(/\bORDER\s+BY\s+'[^']+'/i.test(s))return {type:'logical',message:'Az ORDER BY aposztrófos szövegkonstanst kapott, nem oszlopazonosítót. Használj backticket.'};
  if(/\b(SUBSTRING|SUBSTR|MID)\s*\(\s*(?:'[^']*'|`[^`]+`)\s*,\s*0\s*[,)]/i.test(s))return {type:'logical',message:'A MySQL-ben a szöveg pozíciója 1-től indul, ezért a 0 kezdőpozíció üres eredményt ad. Az első karakterhez 1-et írj.'};
  if(/\bFORMAT\s*\([^()]*\)\s*(?:>=|<=|>|<|=)\s*-?\d/i.test(s))return {type:'logical',message:'A FORMAT() szöveget ad vissza, ezért számként nem hasonlítható össze. A WHERE feltételben a nyers számértéket használd.'};
  if(/\b(SUM|AVG|MIN|MAX|COUNT)\s*\([^)]*\)\s*[+*\/-]\s*\([^)]*`[^`]+`[^)]*\)/i.test(s)&&!/\bGROUP\s+BY\b/i.test(s))return {type:'sql',message:'Az összesítő függvény eredménye mellett nem használható nem összesített mező GROUP BY nélkül. Tedd a teljes soronkénti kifejezést az összesítő függvény belsejébe.'};
  if(/\bSELECT\b[\s\S]*?\b(SUM|AVG|MIN|MAX|COUNT)\s*\([^)]*\)[\s\S]*?\bFROM\b/i.test(s)&&!/\bGROUP\s+BY\b/i.test(s)){
    const select=mysqlSelectList(s);
    const stripped=select.replace(/\b(SUM|AVG|MIN|MAX|COUNT)\s*\([^)]*\)/gi,'').replace(/\bROUND\s*\([^)]*\)/gi,'').replace(/\bAS\s+`[^`]+`/gi,'').replace(/[\s,0-9.+*()'-]/g,'');
    if(/`[^`]+`|\b[a-z_][a-z0-9_]*\b/i.test(stripped))return {type:'sql',message:'Aggregált lekérdezésben GROUP BY nélkül nem szerepelhet nem összesített oszlop a SELECT-listában.'};
  }
  return null;
}

/* =========================================================================
 * Szintaxiskiemelés a tananyag CSS-osztályaival:
 *   .kw (kulcsszó), .fn (függvény), .str (szöveg), .num (szám),
 *   .ident (backtickes azonosító), .comment (megjegyzés)
 * ========================================================================= */

/* Saját HTML-escape, hogy a fájl önállóan is működjön, az oldal esc()
   függvényétől függetlenül. */
function mysqlEsc(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function sqlHighlight(s){const kw=new Set(['SELECT','FROM','AS','WHERE','ORDER','BY','ASC','DESC','DISTINCT','IS','NOT','NULL','LIMIT','GROUP','HAVING','AND','OR','DIV','LIKE','BETWEEN','IN','LEADING','TRAILING','BOTH']);const fn=new Set(['ABS','MOD','POW','POWER','SQRT','PI','ROUND','CEIL','CEILING','FLOOR','TRUNCATE','SUM','AVG','MIN','MAX','COUNT','CONCAT','CONCAT_WS','UPPER','UCASE','LOWER','LCASE','LENGTH','OCTET_LENGTH','CHAR_LENGTH','CHARACTER_LENGTH','LEFT','RIGHT','SUBSTRING','SUBSTR','MID','LOCATE','INSTR','REPLACE','TRIM','LTRIM','RTRIM','REPEAT','LPAD','RPAD','REVERSE','FORMAT']);const token=/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|--[^\n]*|\b(?:SELECT|FROM|AS|WHERE|ORDER|BY|ASC|DESC|DISTINCT|IS|NOT|NULL|LIMIT|GROUP|HAVING|AND|OR|DIV|LIKE|BETWEEN|IN|LEADING|TRAILING|BOTH)\b|\b(?:ABS|MOD|POW|POWER|SQRT|PI|ROUND|CEIL|CEILING|FLOOR|TRUNCATE|SUM|AVG|MIN|MAX|COUNT|CONCAT|CONCAT_WS|UPPER|UCASE|LOWER|LCASE|LENGTH|OCTET_LENGTH|CHAR_LENGTH|CHARACTER_LENGTH|LEFT|RIGHT|SUBSTRING|SUBSTR|MID|LOCATE|INSTR|REPLACE|TRIM|LTRIM|RTRIM|REPEAT|LPAD|RPAD|REVERSE|FORMAT)\b(?=\s*\()|\b\d+(?:\.\d+)?\b/gi;return String(s).replace(token,m=>{const u=m.toUpperCase(),e=mysqlEsc(m);if(m.startsWith('--'))return '<span class="comment">'+e+'</span>';if(m[0]==="'"||m[0]==="\"")return '<span class="str">'+e+'</span>';if(m[0]==='`')return '<span class="ident">'+e+'</span>';if(fn.has(u))return '<span class="fn">'+e+'</span>';if(kw.has(u))return '<span class="kw">'+e+'</span>';return '<span class="num">'+e+'</span>';});}
