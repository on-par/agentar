/**
 * English text → Oculus viseme conversion.
 *
 * The letter-to-sound rules below are adapted from the TalkingHead project
 * (https://github.com/met4citizen/TalkingHead, MIT License, (c) 2023-2024
 * Mika Suominen), which in turn adapted them from NRL Report 7948,
 * "Automatic Translation of English Text to Phonetics by Means of
 * Letter-to-Sound Rules" (Elovitz, Johnson, McHugh & Shore, 1976).
 * See THIRD_PARTY_NOTICES.md at the repository root.
 *
 * The output is a list of words, each with visemes and *relative* durations
 * (1.0 ≈ an average phoneme). The timeline module turns these into seconds.
 */
import { isViseme, type Viseme } from "../visemes.js";

const RULES: Record<string, string[]> = {
  A: [
    "[A] =aa", " [ARE] =aa RR", " [AR]O=aa RR", "[AR]#=E RR",
    " ^[AS]#=E SS", "[A]WA=aa", "[AW]=aa", " :[ANY]=E nn I",
    "[A]^+#=E", "#:[ALLY]=aa nn I", " [AL]#=aa nn", "[AGAIN]=aa kk E nn",
    "#:[AG]E=I kk", "[A]^+:#=aa", ":[A]^+ =E", "[A]^%=E",
    " [ARR]=aa RR", "[ARR]=aa RR", " :[AR] =aa RR", "[AR] =E",
    "[AR]=aa RR", "[AIR]=E RR", "[AI]=E", "[AY]=E", "[AU]=aa",
    "#:[AL] =aa nn", "#:[ALS] =aa nn SS", "[ALK]=aa kk", "[AL]^=aa nn",
    " :[ABLE]=E PP aa nn", "[ABLE]=aa PP aa nn", "[ANG]+=E nn kk", "[A]=aa",
  ],
  B: [" [BE]^#=PP I", "[BEING]=PP I I nn", " [BOTH] =PP O TH", " [BUS]#=PP I SS", "[BUIL]=PP I nn", "[B]=PP"],
  C: [
    " [CH]^=kk", "^E[CH]=kk", "[CH]=CH", " S[CI]#=SS aa", "[CI]A=SS", "[CI]O=SS",
    "[CI]EN=SS", "[C]+=SS", "[CK]=kk", "[COM]%=kk aa PP", "[C]=kk",
  ],
  D: [
    "#:[DED] =DD I DD", ".E[D] =DD", "#^:E[D] =DD", " [DE]^#=DD I", " [DO] =DD U",
    " [DOES]=DD aa SS", " [DOING]=DD U I nn", " [DOW]=DD aa", "[DU]A=kk U", "[D]=DD",
  ],
  E: [
    "#:[E] =", "'^:[E] =", " :[E] =I", "#[ED] =DD", "#:[E]D =", "[EV]ER=E FF", "[E]^%=I",
    "[ERI]#=I RR I", "[ERI]=E RR I", "#:[ER]#=E", "[ER]#=E RR", "[ER]=E", " [EVEN]=I FF E nn",
    "#:[E]W=", "@[EW]=U", "[EW]=I U", "[E]O=I", "#:&[ES] =I SS", "#:[E]S =", "#:[ELY] =nn I",
    "#:[EMENT]=PP E nn DD", "[EFUL]=FF U nn", "[EE]=I", "[EARN]=E nn", " [EAR]^=E", "[EAD]=E DD",
    "#:[EA] =I aa", "[EA]SU=E", "[EA]=I", "[EIGH]=E", "[EI]=I", " [EYE]=aa", "[EY]=I", "[EU]=I U",
    "[E]=E",
  ],
  F: ["[FUL]=FF U nn", "[F]=FF"],
  G: [
    "[GIV]=kk I FF", " [G]I^=kk", "[GE]T=kk E", "SU[GGES]=kk kk E SS", "[GG]=kk", " B#[G]=kk",
    "[G]+=kk", "[GREAT]=kk RR E DD", "#[GH]=", "[G]=kk",
  ],
  H: [" [HAV]=I aa FF", " [HERE]=I I RR", " [HOUR]=aa E", "[HOW]=I aa", "[H]#=I", "[H]="],
  I: [
    " [IN]=I nn", " [I] =aa", "[IN]D=aa nn", "[IER]=I E", "#:R[IED] =I DD", "[IED] =aa DD",
    "[IEN]=I E nn", "[IE]T=aa E", " :[I]%=aa", "[I]%=I", "[IE]=I", "[I]^+:#=I", "[IR]#=aa RR",
    "[IZ]%=aa SS", "[IS]%=aa SS", "[I]D%=aa", "+^[I]^+=I", "[I]T%=aa", "#^:[I]^+=I", "[I]^+=aa",
    "[IR]=E", "[IGH]=aa", "[ILD]=aa nn DD", "[IGN] =aa nn", "[IGN]^=aa nn", "[IGN]%=aa nn",
    "[IQUE]=I kk", "[I]=I",
  ],
  J: ["[J]=kk"],
  K: [" [K]N=", "[K]=kk"],
  L: ["[LO]C#=nn O", "L[L]=", "#^:[L]%=aa nn", "[LEAD]=nn I DD", "[L]=nn"],
  M: ["[MOV]=PP U FF", "[M]=PP"],
  N: [
    "E[NG]+=nn kk", "[NG]R=nn kk", "[NG]#=nn kk", "[NGL]%=nn kk aa nn", "[NG]=nn", "[NK]=nn kk",
    " [NOW] =nn aa", "[N]=nn",
  ],
  O: [
    "[OF] =aa FF", "[OROUGH]=E O", "#:[OR] =E", "#:[ORS] =E SS", "[OR]=aa RR", " [ONE]=FF aa nn",
    "[OW]=O", " [OVER]=O FF E", "[OV]=aa FF", "[O]^%=O", "[O]^EN=O", "[O]^I#=O", "[OL]D=O nn",
    "[OUGHT]=aa DD", "[OUGH]=aa FF", " [OU]=aa", "H[OU]S#=aa", "[OUS]=aa SS", "[OUR]=aa RR",
    "[OULD]=U DD", "^[OU]^L=aa", "[OUP]=U PP", "[OU]=aa", "[OY]=O", "[OING]=O I nn", "[OI]=O",
    "[OOR]=aa RR", "[OOK]=U kk", "[OOD]=U DD", "[OO]=U", "[O]E=O", "[O] =O", "[OA]=O",
    " [ONLY]=O nn nn I", " [ONCE]=FF aa nn SS", "[ON'T]=O nn DD", "C[O]N=aa", "[O]NG=aa",
    " ^:[O]N=aa", "I[ON]=aa nn", "#:[ON] =aa nn", "#^[ON]=aa nn", "[O]ST =O", "[OF]^=aa FF",
    "[OTHER]=aa TH E", "[OSS] =aa SS", "#^:[OM]=aa PP", "[O]=aa",
  ],
  P: ["[PH]=FF", "[PEOP]=PP I PP", "[POW]=PP aa", "[PUT] =PP U DD", "[P]=PP"],
  Q: ["[QUAR]=kk FF aa RR", "[QU]=kk FF", "[Q]=kk"],
  R: [" [RE]^#=RR I", "[R]=RR"],
  S: [
    "[SH]=SS", "#[SION]=SS aa nn", "[SOME]=SS aa PP", "#[SUR]#=SS E", "[SUR]#=SS E", "#[SU]#=SS U",
    "#[SSU]#=SS U", "#[SED] =SS DD", "#[S]#=SS", "[SAID]=SS E DD", "^[SION]=SS aa nn", "[S]S=",
    ".[S] =SS", "#:.E[S] =SS", "#^:##[S] =SS", "#^:#[S] =SS", "U[S] =SS", " :#[S] =SS",
    " [SCH]=SS kk", "[S]C+=", "#[SM]=SS PP", "#[SN]'=SS aa nn", "[S]=SS",
  ],
  T: [
    " [THE] =TH aa", "[TO] =DD U", "[THAT] =TH aa DD", " [THIS] =TH I SS", " [THEY]=TH E",
    " [THERE]=TH E RR", "[THER]=TH E", "[THEIR]=TH E RR", " [THAN] =TH aa nn", " [THEM] =TH E PP",
    "[THESE] =TH I SS", " [THEN]=TH E nn", "[THROUGH]=TH RR U", "[THOSE]=TH O SS",
    "[THOUGH] =TH O", " [THUS]=TH aa SS", "[TH]=TH", "#:[TED] =DD I DD", "S[TI]#N=CH", "[TI]O=SS",
    "[TI]A=SS", "[TIEN]=SS aa nn", "[TUR]#=CH E", "[TU]A=CH U", " [TWO]=DD U", "[T]=DD",
  ],
  U: [
    " [UN]I=I U nn", " [UN]=aa nn", " [UPON]=aa PP aa nn", "@[UR]#=U RR", "[UR]#=I U RR", "[UR]=E",
    "[U]^ =aa", "[U]^^=aa", "[UY]=aa", " G[U]#=", "G[U]%=", "G[U]#=FF", "#N[U]=I U", "@[U]=I",
    "[U]=I U",
  ],
  V: ["[VIEW]=FF I U", "[V]=FF"],
  W: [
    " [WERE]=FF E", "[WA]S=FF aa", "[WA]T=FF aa", "[WHERE]=FF E RR", "[WHAT]=FF aa DD",
    "[WHOL]=I O nn", "[WHO]=I U", "[WH]=FF", "[WAR]=FF aa RR", "[WOR]^=FF E", "[WR]=RR", "[W]=FF",
  ],
  X: [" [X]=SS", "[X]=kk SS"],
  Y: [
    "[YOUNG]=I aa nn", " [YOU]=I U", " [YES]=I E SS", " [Y]=I", "#^:[Y] =I", "#^:[Y]I=I",
    " :[Y] =aa", " :[Y]#=aa", " :[Y]^+:#=I", " :[Y]^#=I", "[Y]=I",
  ],
  Z: ["[Z]=SS"],
};

const OPS: Record<string, string> = {
  "#": "[AEIOUY]+", // one or more vowels
  ".": "[BDVGJLMNRWZ]", // one voiced consonant
  "%": "(?:ER|E|ES|ED|ING|ELY)", // common suffixes
  "&": "(?:[SCGZXJ]|CH|SH)",
  "@": "(?:[TSRDLZNJ]|TH|CH|SH)",
  "^": "[BCDFGHJKLMNPQRSTVWXZ]", // one consonant
  "+": "[EIY]",
  ":": "[BCDFGHJKLMNPQRSTVWXZ]*", // zero or more consonants
  " ": "\\b", // word boundary
};

interface CompiledRule {
  regex: RegExp;
  move: number;
  visemes: Viseme[];
}

function compile(rule: string): CompiledRule {
  const posL = rule.indexOf("[");
  const posR = rule.indexOf("]");
  const posE = rule.indexOf("=");
  const left = rule.substring(0, posL);
  const letters = [...rule.substring(posL + 1, posR)];
  const right = rule.substring(posR + 1, posE);
  const out = rule.substring(posE + 1);
  // The first matched letter is lower-cased in the test string so the regex
  // is anchored on the current reading position.
  letters[0] = letters[0]!.toLowerCase();
  const exp =
    [...left].map((c) => OPS[c] ?? c).join("") +
    letters.join("") +
    [...right].map((c) => OPS[c] ?? c).join("");
  return {
    regex: new RegExp(exp),
    move: letters.length,
    visemes: out.length ? out.split(" ").filter(isViseme) : [],
  };
}

const COMPILED: Record<string, CompiledRule[]> = Object.fromEntries(
  Object.entries(RULES).map(([k, rules]) => [k, rules.map(compile)]),
);

/** Relative viseme durations (1 ≈ average phoneme). */
const VISEME_DURATION: Record<Viseme, number> = {
  sil: 1, aa: 0.95, E: 0.9, I: 0.92, O: 0.96, U: 0.95, PP: 1.08, SS: 1.23,
  TH: 1, DD: 1.05, FF: 1, kk: 1.21, nn: 0.88, RR: 0.88, CH: 1.1,
};

/** Relative pause lengths inserted for punctuation between words. */
export const PAUSE_WEIGHT: Record<string, number> = {
  ",": 2.5, ";": 3, ":": 3, ".": 4, "!": 4, "?": 4, "-": 0.8, "—": 2, "…": 4,
};

export interface VisemeKey {
  viseme: Viseme;
  /** Start time relative to the start of the word, in relative units. */
  start: number;
  /** Duration in relative units. */
  duration: number;
}

export interface WordVisemes {
  word: string;
  /** Character offset of the word in the (pre-processed) text. */
  charIndex: number;
  visemes: VisemeKey[];
  /** Total duration of the word in relative units. */
  duration: number;
  /** Relative pause after this word (punctuation). */
  pauseAfter: number;
}

/** Convert a single word (letters and apostrophes) to visemes. */
export function wordToVisemes(word: string): { visemes: VisemeKey[]; duration: number } {
  const upper = word.toUpperCase();
  const chars = [...upper];
  const visemes: VisemeKey[] = [];
  let t = 0;
  let i = 0;
  while (i < chars.length) {
    const c = chars[i]!;
    const ruleset = COMPILED[c];
    if (!ruleset) {
      i++;
      continue;
    }
    // Each ruleset ends with a catch-all rule, so a rule always matches.
    const test = upper.substring(0, i) + c.toLowerCase() + upper.substring(i + 1);
    const rule = ruleset.find((r) => r.regex.test(test)) ?? ruleset[ruleset.length - 1]!;
    for (const v of rule.visemes) {
      const last = visemes[visemes.length - 1];
      if (last && last.viseme === v) {
        // Repeated viseme: extend instead of re-triggering.
        const d = 0.7 * VISEME_DURATION[v];
        last.duration += d;
        t += d;
      } else {
        const d = VISEME_DURATION[v];
        visemes.push({ viseme: v, start: t, duration: d });
        t += d;
      }
    }
    i += rule.move;
  }
  return { visemes, duration: t };
}

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const TEENS = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function numberToWords(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (n < 0) return `minus ${numberToWords(-n)}`;
  if (!Number.isInteger(n)) {
    const [whole, frac = ""] = String(n).split(".");
    return `${numberToWords(Number(whole))} point ${[...frac].map((d) => ONES[Number(d)]).join(" ")}`;
  }
  if (n < 10) return ONES[n]!;
  if (n < 20) return TEENS[n - 10]!;
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? " " + ONES[n % 10] : ""}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? " " + numberToWords(n % 100) : ""}`;
  if (n < 1_000_000) return `${numberToWords(Math.floor(n / 1000))} thousand${n % 1000 ? " " + numberToWords(n % 1000) : ""}`;
  if (n < 1_000_000_000) return `${numberToWords(Math.floor(n / 1_000_000))} million${n % 1_000_000 ? " " + numberToWords(n % 1_000_000) : ""}`;
  // Very large numbers: read digit by digit.
  return [...String(n)].map((d) => ONES[Number(d)]).join(" ");
}

const SYMBOLS: Record<string, string> = { "%": " percent", "&": " and ", "+": " plus ", $: " dollars ", "@": " at ", "=": " equals " };

/**
 * Normalise text so the letter-to-sound rules see only letters, apostrophes
 * and punctuation that marks pauses. This is used for mouth shapes only; the
 * TTS engine receives the original text.
 */
export function normalizeForLipSync(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[%&+$@=]/g, (s) => SYMBOLS[s] ?? " ")
    .replace(/\d+(?:\.\d+)?/g, (m) => ` ${numberToWords(Number(m))} `)
    .replace(/[’‘]/g, "'")
    .replace(/[^A-Za-z' ,.;:!?\-—…\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Convert free text to per-word visemes with relative timing. */
export function textToVisemes(text: string): WordVisemes[] {
  const clean = normalizeForLipSync(text);
  const words: WordVisemes[] = [];
  const re = /([A-Za-z']+)([^A-Za-z']*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const word = m[1]!.replace(/^'+|'+$/g, "");
    if (!word) continue;
    const trailing = m[2] ?? "";
    let pauseAfter = 0;
    for (const ch of trailing) pauseAfter = Math.max(pauseAfter, PAUSE_WEIGHT[ch] ?? 0);
    const { visemes, duration } = wordToVisemes(word);
    words.push({ word, charIndex: m.index, visemes, duration, pauseAfter });
  }
  return words;
}
