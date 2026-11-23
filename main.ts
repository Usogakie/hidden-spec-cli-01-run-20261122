// mend: one patch tool for every AI edit format.
// Applies a patch (unified diff, SEARCH/REPLACE blocks, V4A, or JSON edits)
// to a tree of text files, all or nothing. Node 22, standard library only.
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// See SPEC.md for the whole contract.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { runTrial } from './runner.ts';

/** One file's lines, its line break, and whether it ends with one. */
interface FileState {
  lines: string[];
  br: '\n' | '\r\n';
  end: boolean;
}

/** A failed edit: its code and the path it concerns. */
interface Fail {
  code: string;
  path: string;
}

/** Split a file's text into its lines, break and final-break flag. */
function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', end: false };
  const firstLf = text.indexOf('\n');
  const br: '\n' | '\r\n' = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const end = text.endsWith(br);
  const body = end ? text.slice(0, -br.length) : text;
  // A file that is exactly one line break holds one empty line; only the
  // empty text holds no lines.
  const lines = body === '' ? (end ? [''] : []) : body.split(br);
  return { lines, br, end };
}

/** Render a file's lines back to its text. */
function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  const body = f.lines.join(f.br);
  return f.end ? body + f.br : body;
}

/** Split a patch's text into its lines: at '\n', one trailing '\r' off each, no empty piece after a final '\n'. */
function splitPatch(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Split any string the way section 9 splits new_str: at '\n', one trailing '\r' off each, no empty piece after a final '\n'. */
function splitTextLines(text: string): string[] {
  return splitPatch(text);
}

/** A path is safe when it is not empty, does not start with '/', holds no '\', and none of its '/'-separated segments is empty, '.' or '..'. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/** Compare two strings in UTF-8 byte order. */
function byteCmp(a: string, b: string): number {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return Buffer.compare(ba, bb);
}

/** The tree, in memory: the files as the edits leave them, over the files on disk. */
class Tree {
  /** Current content by path; null means deleted. Absent means untouched so far. */
  private cur = new Map<string, FileState | null>();
  /** Initial raw text by path for every path touched; null when it did not exist. */
  private init = new Map<string, string | null>();
  /** Moves, in the order their edits ran. */
  private moves: Array<{ old: string; nw: string }> = [];

  /** Raw initial text of a path (null when it did not exist), read once from disk. */
  initialText(p: string): string | null {
    if (!this.init.has(p)) {
      let text: string | null = null;
      try {
        const st = statSync(p);
        if (st.isFile()) text = readFileSync(p, 'utf8');
      } catch {
        text = null;
      }
      this.init.set(p, text);
    }
    return this.init.get(p) ?? null;
  }

  /** Current state of a path; null when it does not exist now. */
  get(p: string): FileState | null {
    if (this.cur.has(p)) return this.cur.get(p) ?? null;
    const text = this.initialText(p);
    if (text === null) return null;
    const f = parseFile(text);
    this.cur.set(p, f);
    return f;
  }

  /** Current raw text of a path; null when it does not exist now. */
  getText(p: string): string | null {
    const f = this.get(p);
    return f === null ? null : renderFile(f);
  }

  /** Whether a path exists now (as a file). */
  exists(p: string): boolean {
    return this.get(p) !== null;
  }

  /** Set a path's current state; null deletes it. */
  set(p: string, f: FileState | null): void {
    this.initialText(p);
    this.cur.set(p, f);
  }

  /** Set a path from raw text. */
  setText(p: string, text: string): void {
    this.set(p, parseFile(text));
  }

  /** Record a move edit that ran. */
  recordMove(old: string, nw: string): void {
    this.moves.push({ old, nw });
  }

  /** Every path touched, initial or current. */
  touched(): Set<string> {
    const out = new Set<string>();
    for (const p of this.init.keys()) out.add(p);
    for (const p of this.cur.keys()) out.add(p);
    return out;
  }

  /** The change lines for the final output, in byte order of their sort key. */
  changes(): string[] {
    const covered = new Set<string>();
    const lines: Array<{ key: string; text: string }> = [];
    for (const m of this.moves) {
      const oldInit = this.initialText(m.old);
      const newInit = this.initialText(m.nw);
      const oldNow = this.get(m.old);
      const newNow = this.get(m.nw);
      if (oldInit !== null && oldNow === null && newInit === null && newNow !== null) {
        lines.push({ key: m.nw, text: `R ${m.old} -> ${m.nw}` });
        covered.add(m.old);
        covered.add(m.nw);
      }
    }
    for (const p of this.touched()) {
      if (covered.has(p)) continue;
      const before = this.initialText(p);
      const after = this.getText(p);
      if (before === null && after !== null) lines.push({ key: p, text: `A ${p}` });
      else if (before !== null && after === null) lines.push({ key: p, text: `D ${p}` });
      else if (before !== null && after !== null && before !== after) lines.push({ key: p, text: `M ${p}` });
    }
    lines.sort((a, b) => byteCmp(a.key, b.key));
    return lines.map((l) => l.text);
  }

  /** Write every current state to disk (only paths that changed). */
  writeAll(): void {
    for (const p of this.touched()) {
      const before = this.initialText(p);
      const after = this.getText(p);
      if (before === after) continue;
      if (after === null) {
        try {
          rmSync(p, { force: true });
        } catch {
          // A file already gone is gone.
        }
      } else {
        const dir = dirname(p);
        if (dir !== '.' && dir !== '') mkdirSync(dir, { recursive: true });
        writeFileSync(p, after, 'utf8');
      }
    }
  }
}

/** Normalize one line for a tier: 0 exact, 1 trailing spaces/tabs off, 2 both ends off. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Leading spaces and tabs of a line. */
function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** 0-based positions where O occurs in F at a tier; occurrences may overlap. */
function occurrences(o: string[], f: string[], tier: number): number[] {
  const res: number[] = [];
  if (o.length === 0 || o.length > f.length) return res;
  const no = o.map((l) => normLine(l, tier));
  const nf = f.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= f.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (nf[i + j] !== no[j]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier (0, then 1, then 2; strict: 0 only) at which O occurs, with its positions. */
function firstTier(o: string[], f: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(o, f, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/**
 * Replace F's lines at pos (O's lines) with N.
 * nToO[i] is the index into O of N[i] when it is a context line, else -1.
 * A context line is written as the file's own matched line; at tier 2 every
 * other line of N is re-indented from O's first line's leading whitespace to
 * the file's first matched line's.
 */
function replaceLines(
  f: FileState,
  o: string[],
  n: string[],
  nToO: Array<number | -1>,
  pos: number,
  tier: number,
  endOverride?: boolean,
): FileState {
  const out: string[] = [];
  const pLead = o.length > 0 ? leadWs(o[0]) : '';
  const fLead = o.length > 0 && pos < f.lines.length ? leadWs(f.lines[pos]) : '';
  for (let i = 0; i < n.length; i++) {
    const oi = nToO[i];
    if (oi !== undefined && oi !== -1) {
      out.push(f.lines[pos + oi]);
    } else {
      let line = n[i];
      if (tier === 2 && o.length > 0 && line !== '' && line.trim() !== '' && line.startsWith(pLead)) {
        line = fLead + line.slice(pLead.length);
      }
      out.push(line);
    }
  }
  const lines = [...f.lines.slice(0, pos), ...out, ...f.lines.slice(pos + o.length)];
  // A changed file keeps its final break; a format may override it (unified, section 6).
  return { lines, br: f.br, end: endOverride !== undefined ? endOverride : f.end };
}

/** Insert lines at a 0-based position (after that many lines), keeping the file's final break. */
function insertLines(f: FileState, at: number, ins: string[]): FileState {
  const lines = [...f.lines.slice(0, at), ...ins, ...f.lines.slice(at)];
  return { lines, br: f.br, end: f.end };
}

/** One parsed edit: apply it to the tree, or report its failure. */
type Applier = (t: Tree, strict: boolean) => Fail | null;

/** A parse fault: the 1-based patch line it names. */
class ParseFault extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

/** Strip a leading a/ or b/ from a unified path. */
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Parse a --- or +++ path: text after the four characters, up to the first tab, surrounding spaces removed. */
function parseDiffPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  return rest.trim();
}

interface UniHunk {
  a: number;
  o: string[];
  n: string[];
  nToO: Array<number | -1>;
  noNlAfterN: boolean;
  lastPlusNoNl: boolean;
}

/** Parse one hunk body starting at i (the line after the @@ header). Returns the hunk and the index after it. */
function parseHunkBody(lines: string[], i: number): { hunk: Omit<UniHunk, 'a'>; next: number } {
  const raw: string[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      raw.push(l);
      j++;
    } else {
      break;
    }
  }
  // Empty lines at the end of a body are not part of it.
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const o: string[] = [];
  const n: string[] = [];
  const nToO: Array<number | -1> = [];
  for (let k = 0; k < raw.length; k++) {
    const l = raw[k];
    if (l.startsWith(' ')) {
      const text = l.slice(1);
      nToO.push(o.length);
      o.push(text);
      n.push(text);
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push(l.slice(1));
      nToO.push(-1);
    } else if (l.startsWith('\\')) {
      // A \ line refers to the body line before it; it adds no line of its own.
    } else if (l === '') {
      nToO.push(o.length);
      o.push('');
      n.push('');
    }
  }
  // A \ line counts only when it follows the hunk's last context or + line (the last line of N),
  // or, for lastPlusNoNl, the hunk's last + line.
  let noNlAfterN = false;
  let lastPlusNoNl = false;
  for (let k = raw.length - 1; k >= 0; k--) {
    if (raw[k].startsWith(' ') || raw[k].startsWith('+')) {
      if (k + 1 < raw.length && raw[k + 1].startsWith('\\')) noNlAfterN = true;
      break;
    }
  }
  for (let k = raw.length - 1; k >= 0; k--) {
    if (raw[k].startsWith('+')) {
      if (k + 1 < raw.length && raw[k + 1].startsWith('\\')) lastPlusNoNl = true;
      break;
    }
  }
  return { hunk: { o, n, nToO, noNlAfterN, lastPlusNoNl }, next: j };
}

/** Parse a unified patch into section appliers. */
function parseUnified(lines: string[]): Applier[] {
  const edits: Applier[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const sec = parseUniSection(lines, i);
      edits.push(sec.apply);
      i = sec.next;
    } else if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const sec = parseUniSection(lines, i);
      edits.push(sec.apply);
      i = sec.next;
    } else if (line.startsWith('@@')) {
      throw new ParseFault(i + 1);
    } else {
      i++;
    }
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: UniHunk[];
}

/** Parse one unified section starting at i. Returns the applier and the index after the section. */
function parseUniSection(lines: string[], start: number): { apply: Applier; next: number } {
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let create = false;
  let del = false;
  let hasDiffPair = false;
  let i = start;
  // diff --git start: parse a/<X> b/<Y>.
  if (lines[i].startsWith('diff --git ')) {
    const rest = lines[i].slice('diff --git '.length);
    const m = /^a\/(\S+) b\/(\S+)\s*$/.exec(rest);
    if (!m) throw new ParseFault(i + 1);
    oldPath = m[1];
    newPath = m[2];
    i++;
  }
  const hunks: UniHunk[] = [];
  // Header lines until the first hunk, the next section, or the end.
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ')) {
      if (i + 1 >= lines.length || !lines[i + 1].startsWith('+++ ')) throw new ParseFault(i + 2);
      oldPath = parseDiffPath(l);
      newPath = parseDiffPath(lines[i + 1]);
      hasDiffPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('+++ ')) {
      // A +++ without a --- before it in the header: ignore it.
      i++;
      continue;
    }
    if (l.startsWith('rename from ')) {
      // Rename lines name the paths only when no ---/+++ pair does.
      if (!hasDiffPair) oldPath = l.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (!hasDiffPair) newPath = l.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('new file mode')) {
      create = true;
      i++;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      del = true;
      i++;
      continue;
    }
    // index, old/new mode, similarity/dissimilarity, Index:, and any other line: ignored.
    i++;
  }
  // Hunks until the next section or the end.
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (!m) throw new ParseFault(i + 1);
      const a = parseInt(m[1], 10);
      const body = parseHunkBody(lines, i + 1);
      hunks.push({ a, ...body.hunk });
      i = body.next;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i++;
  }
  const sec: UniSection = { oldPath, newPath, create, del, hunks };
  return { apply: (t, strict) => applyUniSection(t, sec, strict), next: i };
}

/** Apply one unified section to the tree. */
function applyUniSection(t: Tree, sec: UniSection, strict: boolean): Fail | null {
  const oldP = sec.oldPath === null ? null : sec.oldPath === '/dev/null' ? null : stripAB(sec.oldPath);
  const newP = sec.newPath === null ? null : sec.newPath === '/dev/null' ? null : stripAB(sec.newPath);
  const isCreate = sec.create || (sec.oldPath === '/dev/null' && newP !== null);
  const isDelete = sec.del || (sec.newPath === '/dev/null' && oldP !== null);
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  const path = isCreate ? newP : isDelete ? oldP : isMove ? oldP : oldP ?? newP;
  // Every path the edit names is checked for safety before anything else.
  for (const p of [oldP, newP]) {
    if (p !== null && !isSafePath(p)) return { code: 'unsafe', path: p };
  }
  if (isCreate) {
    const np = newP as string;
    if (t.exists(np)) return { code: 'exists', path: np };
    const plus: string[] = [];
    for (const h of sec.hunks) {
      // The file is the + lines of all its hunks, in order.
      const bodyPlus = hunkPlusLines(h);
      plus.push(...bodyPlus);
    }
    let end = true;
    // A created file ends with a break unless a \ line follows its last + line.
    const lastH = [...sec.hunks].reverse().find((h) => hunkPlusLines(h).length > 0);
    if (lastH) end = !lastH.lastPlusNoNl;
    if (plus.length === 0) end = false;
    t.set(np, { lines: plus, br: '\n', end });
    return null;
  }
  if (isDelete) {
    const op = oldP as string;
    if (!t.exists(op)) return { code: 'missing', path: op };
    t.set(op, null);
    return null;
  }
  const op = (isMove ? oldP : oldP ?? newP) as string;
  if (!t.exists(op)) return { code: 'missing', path: op };
  if (isMove) {
    const np = newP as string;
    if (t.exists(np)) return { code: 'exists', path: np };
  }
  let cur = t.get(op) as FileState;
  let d = 0;
  for (const h of sec.hunks) {
    const r = applyUniHunk(cur, h, d, strict);
    if ('code' in r) return { code: r.code, path: op };
    cur = r.file;
    d += h.n.length - h.o.length;
  }
  if (isMove) {
    const np = newP as string;
    t.set(np, cur);
    t.set(op, null);
    t.recordMove(op, np);
  } else {
    t.set(op, cur);
  }
  return null;
}

/** The + lines of a hunk, in body order (context lines excluded). */
function hunkPlusLines(h: UniHunk): string[] {
  const out: string[] = [];
  for (let i = 0; i < h.n.length; i++) {
    if (h.nToO[i] === -1) out.push(h.n[i]);
  }
  return out;
}

/** Apply one unified hunk to a file's lines. Returns the new file or a failure code. */
function applyUniHunk(f: FileState, h: UniHunk, d: number, strict: boolean): { file: FileState } | { code: string } {
  if (h.o.length === 0) {
    // After the first A + d lines; a negative position is the top of the file.
    const at = Math.max(0, Math.min(h.a + d, f.lines.length));
    const ins = insertLines(f, at, h.n);
    const atEnd = at >= f.lines.length;
    const end = atEnd ? !h.noNlAfterN : f.end;
    return { file: { lines: ins.lines, br: ins.br, end } };
  }
  const found = firstTier(h.o, f.lines, strict);
  if (found === null) return { code: 'no-match' };
  const want = h.a - 1 + d;
  let best = found.pos[0];
  for (const p of found.pos) {
    if (Math.abs(p - want) < Math.abs(best - want)) best = p;
  }
  const runsToEnd = best + h.o.length >= f.lines.length;
  const end = runsToEnd ? !h.noNlAfterN : f.end;
  const file = replaceLines(f, h.o, h.n, h.nToO, best, found.tier, end);
  return { file };
}

/** Marker lines are matched with trailing whitespace removed. */
function marker(line: string, want: string): boolean {
  return line.replace(/[ \t]+$/, '') === want;
}

/** Parse SEARCH/REPLACE blocks into appliers. */
function parseSearchReplace(lines: string[]): Applier[] {
  const edits: Applier[] = [];
  let prevEnd = -1; // index just after the previous block's REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (!marker(lines[i], '<<<<<<< SEARCH')) {
      i++;
      continue;
    }
    const searchIdx = i;
    // The path: nearest line before SEARCH, after the previous block's REPLACE (or the start),
    // not blank and not starting with three backticks once trimmed.
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFault(searchIdx + 1);
    // Find ======= then >>>>>>> REPLACE after the SEARCH line.
    let sep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (marker(lines[j], '=======')) {
        sep = j;
        break;
      }
    }
    if (sep === -1) throw new ParseFault(searchIdx + 1);
    let rep = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (marker(lines[j], '>>>>>>> REPLACE')) {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new ParseFault(searchIdx + 1);
    const oldLines = lines.slice(searchIdx + 1, sep);
    const newLines = lines.slice(sep + 1, rep);
    edits.push(makeSrEdit(path, oldLines, newLines));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

function makeSrEdit(path: string, oldLines: string[], newLines: string[]): Applier {
  return (t: Tree, strict: boolean): Fail | null => {
    if (!isSafePath(path)) return { code: 'unsafe', path };
    if (oldLines.length === 0) {
      if (t.exists(path)) return { code: 'exists', path };
      t.set(path, { lines: [...newLines], br: '\n', end: newLines.length > 0 });
      return null;
    }
    if (!t.exists(path)) return { code: 'missing', path };
    const f = t.get(path) as FileState;
    const found = firstTier(oldLines, f.lines, strict);
    if (found === null) return { code: 'no-match', path };
    if (found.pos.length > 1) return { code: 'ambiguous', path };
    const nToO: Array<number | -1> = newLines.map(() => -1);
    t.set(path, replaceLines(f, oldLines, newLines, nToO, found.pos[0], found.tier));
    return null;
  };
}

/** Parse a V4A patch into appliers. */
function parseV4a(lines: string[]): Applier[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseFault(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);
  const edits: Applier[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const body: string[] = [];
      while (i < last) {
        const l = lines[i];
        if (l.startsWith('*** ')) break;
        if (l === '' || l.startsWith('+')) {
          body.push(l === '' ? '' : l.slice(1));
          i++;
        } else {
          throw new ParseFault(i + 1);
        }
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      edits.push(makeV4aAdd(path, body));
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      edits.push(makeV4aDelete(path));
      i++;
    } else if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i].startsWith('*** Move to: ')) {
        moveTo = lines[i].slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks = parseV4aChunks(lines, i, last);
      i = chunks.next;
      if (chunks.list.length === 0 && moveTo === null) throw new ParseFault(updateLine + 1);
      edits.push(makeV4aUpdate(path, moveTo, chunks.list));
    } else {
      throw new ParseFault(i + 1);
    }
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

interface V4aChunk {
  anchor: string | null;
  o: string[];
  n: string[];
  nToO: Array<number | -1>;
  endOfFile: boolean;
}

/** Parse the chunks of an Update File section starting at i; returns them and the index after the section. */
function parseV4aChunks(lines: string[], start: number, last: number): { list: V4aChunk[]; next: number } {
  const list: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let i = start;
  const pushCur = (): void => {
    if (cur !== null) {
      list.push(cur);
      cur = null;
    }
  };
  while (i < last) {
    const l = lines[i];
    if (l.startsWith('*** End of File')) {
      if (cur === null) throw new ParseFault(i + 1);
      cur.endOfFile = true;
      pushCur();
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      pushCur();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, o: [], n: [], nToO: [], endOfFile: false };
      i++;
      continue;
    }
    if (l.startsWith('*** ')) break;
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      // A chunk starts at an @@ line, or, for the first chunk, at a body line:
      // a body line after a chunk has ended is not a chunk start.
      if (cur === null && list.length > 0) throw new ParseFault(i + 1);
      if (cur === null) cur = { anchor: null, o: [], n: [], nToO: [], endOfFile: false };
      if (l.startsWith(' ')) {
        const text = l.slice(1);
        cur.nToO.push(cur.o.length);
        cur.o.push(text);
        cur.n.push(text);
      } else if (l.startsWith('-')) {
        cur.o.push(l.slice(1));
      } else {
        cur.n.push(l.slice(1));
        cur.nToO.push(-1);
      }
      i++;
      continue;
    }
    if (l === '') {
      // An empty line is an empty context line of the current chunk, or of the
      // first chunk when none has started yet; after a chunk has ended it is a
      // blank line between chunks and is ignored.
      if (cur !== null || list.length === 0) {
        if (cur === null) cur = { anchor: null, o: [], n: [], nToO: [], endOfFile: false };
        cur.nToO.push(cur.o.length);
        cur.o.push('');
        cur.n.push('');
      }
      i++;
      continue;
    }
    throw new ParseFault(i + 1);
  }
  pushCur();
  // Blank lines at the end of a section are not part of it: trim trailing empty context lines of the last chunk.
  if (list.length > 0) {
    const c = list[list.length - 1];
    while (c.o.length > 0 && c.o[c.o.length - 1] === '' && c.n.length > 0 && c.n[c.n.length - 1] === '') {
      // Only trim when the trailing empty line is a context line (present in both).
      const oIdx = c.o.length - 1;
      const nIdx = c.n.length - 1;
      if (c.nToO[nIdx] === oIdx) {
        c.o.pop();
        c.n.pop();
        c.nToO.pop();
      } else {
        break;
      }
    }
  }
  return { list, next: i };
}

function makeV4aAdd(path: string, body: string[]): Applier {
  return (t: Tree): Fail | null => {
    if (!isSafePath(path)) return { code: 'unsafe', path };
    if (t.exists(path)) return { code: 'exists', path };
    t.set(path, { lines: [...body], br: '\n', end: body.length > 0 });
    return null;
  };
}

function makeV4aDelete(path: string): Applier {
  return (t: Tree): Fail | null => {
    if (!isSafePath(path)) return { code: 'unsafe', path };
    if (!t.exists(path)) return { code: 'missing', path };
    t.set(path, null);
    return null;
  };
}

function makeV4aUpdate(path: string, moveTo: string | null, chunks: V4aChunk[]): Applier {
  return (t: Tree, strict: boolean): Fail | null => {
    if (!isSafePath(path)) return { code: 'unsafe', path };
    if (moveTo !== null && !isSafePath(moveTo)) return { code: 'unsafe', path: moveTo };
    if (!t.exists(path)) return { code: 'missing', path };
    if (moveTo !== null && t.exists(moveTo)) return { code: 'exists', path: moveTo };
    let cur = t.get(path) as FileState;
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        const ai = findAnchor(cur, c.anchor, cursor, strict);
        if (ai === null) return { code: 'no-match', path };
        cursor = ai + 1;
      }
      if (c.o.length === 0) {
        const at = c.endOfFile ? cur.lines.length : cursor;
        cur = insertLines(cur, at, c.n);
        cursor = at + c.n.length;
        continue;
      }
      const found = firstTierFrom(c.o, cur.lines, cursor, strict);
      if (found === null) return { code: 'no-match', path };
      let pos: number | null = null;
      for (const p of found.pos) {
        if (c.endOfFile && p + c.o.length !== cur.lines.length) continue;
        pos = p;
        break;
      }
      if (pos === null) return { code: 'no-match', path };
      cur = replaceLines(cur, c.o, c.n, c.nToO, pos, found.tier);
      cursor = pos + c.n.length;
    }
    if (moveTo !== null) {
      t.set(moveTo, cur);
      t.set(path, null);
      t.recordMove(path, moveTo);
    } else {
      t.set(path, cur);
    }
    return null;
  };
}

/** First line at or after the cursor equal to the anchor at the first tier where one is (single line). */
function findAnchor(f: FileState, anchor: string, cursor: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const want = normLine(anchor, tier);
    for (let i = cursor; i < f.lines.length; i++) {
      if (normLine(f.lines[i], tier) === want) return i;
    }
  }
  return null;
}

/** First tier with an occurrence of O at or after the cursor, with its positions. */
function firstTierFrom(o: string[], f: string[], cursor: number, strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const all = occurrences(o, f, tier).filter((p) => p >= cursor);
    if (all.length > 0) return { tier, pos: all };
  }
  return null;
}

/** Parse a JSON patch into appliers (section 9). */
function parseJson(lines: string[]): Applier[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseFault(1);
  const firstCh = lines[first].trimStart()[0];
  if (firstCh !== '[' && firstCh !== '{') throw new ParseFault(1);
  const edits: Applier[] = [];
  if (firstCh === '[') {
    // Array form: one JSON array of edit objects; any fault names the line where the array starts.
    const startLine = first + 1;
    const text = lines.join('\n');
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new ParseFault(startLine);
    }
    if (!Array.isArray(value)) throw new ParseFault(startLine);
    for (const el of value) {
      edits.push(jsonEdit(el, startLine));
    }
  } else {
    // JSON Lines form: one edit object a line, blank lines ignored.
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '') continue;
      let value: unknown;
      try {
        value = JSON.parse(lines[i]) as unknown;
      } catch {
        throw new ParseFault(i + 1);
      }
      edits.push(jsonEdit(value, i + 1));
    }
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

/** Turn one parsed JSON value into an applier, or throw a parse fault at the given line. */
function jsonEdit(value: unknown, faultLine: number): Applier {
  const bad = (): ParseFault => new ParseFault(faultLine);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw bad();
  const obj = value as Record<string, unknown>;
  if (typeof obj.path !== 'string') throw bad();
  const path = obj.path;
  if (typeof obj.command !== 'string') throw bad();
  if (obj.command === 'create') {
    if (typeof obj.file_text !== 'string') throw bad();
    const fileText = obj.file_text;
    return (t: Tree): Fail | null => {
      if (!isSafePath(path)) return { code: 'unsafe', path };
      if (t.exists(path)) return { code: 'exists', path };
      t.setText(path, fileText);
      return null;
    };
  }
  if (obj.command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str === '') throw bad();
    if (obj.new_str !== undefined && typeof obj.new_str !== 'string') throw bad();
    const oldStr = obj.old_str;
    const newStr = typeof obj.new_str === 'string' ? obj.new_str : '';
    return (t: Tree): Fail | null => {
      if (!isSafePath(path)) return { code: 'unsafe', path };
      if (!t.exists(path)) return { code: 'missing', path };
      const f = t.get(path) as FileState;
      let text = t.getText(path) as string;
      let oldS = oldStr;
      let newS = newStr;
      const crlf = f.br === '\r\n';
      if (crlf) {
        text = text.replace(/\r\n/g, '\n');
        oldS = oldS.replace(/\r\n/g, '\n');
        newS = newS.replace(/\r\n/g, '\n');
      }
      let count = 0;
      let at = -1;
      let from = 0;
      while (true) {
        const p = text.indexOf(oldS, from);
        if (p === -1) break;
        count++;
        if (at === -1) at = p;
        if (count > 1) break;
        from = p + 1;
      }
      if (count === 0) return { code: 'no-match', path };
      if (count > 1) return { code: 'ambiguous', path };
      let result = text.slice(0, at) + newS + text.slice(at + oldS.length);
      if (crlf) result = result.replace(/\n/g, '\r\n');
      t.setText(path, result);
      return null;
    };
  }
  if (obj.command === 'insert') {
    if (!Number.isInteger(obj.insert_line)) throw bad();
    if (typeof obj.new_str !== 'string') throw bad();
    const lineNo = obj.insert_line as number;
    const newStr = obj.new_str;
    return (t: Tree): Fail | null => {
      if (!isSafePath(path)) return { code: 'unsafe', path };
      if (!t.exists(path)) return { code: 'missing', path };
      const f = t.get(path) as FileState;
      if (lineNo < 0 || lineNo > f.lines.length) return { code: 'no-match', path };
      const ins = splitTextLines(newStr);
      t.set(path, insertLines(f, lineNo, ins));
      return null;
    };
  }
  throw bad();
}

/** Detect the patch format (section 4); null when none holds. */
function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const firstCh = lines[first].trimStart()[0];
  if (firstCh === '[' || firstCh === '{') return 'json';
  for (const l of lines) {
    if (l.replace(/[ \t]+$/, '') === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

function outLine(s: string): void {
  process.stdout.write(s + '\n');
}

/** The CLI (section 1). Returns the exit code. */
function runCli(): number {
  const argv = process.argv.slice(2);
  let format: string | null = null;
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let patch: string | null = null;
  let afterDashDash = false;
  let usage = false;
  for (const arg of argv) {
    if (afterDashDash) {
      if (patch !== null) {
        usage = true;
        break;
      }
      patch = arg;
      continue;
    }
    if (arg === '--') {
      afterDashDash = true;
      continue;
    }
    if (arg === '-') {
      if (patch !== null) {
        usage = true;
        break;
      }
      patch = '-';
      continue;
    }
    if (arg.startsWith('-')) {
      if (arg.startsWith('--format=')) {
        if (seenFormat) {
          usage = true;
          break;
        }
        seenFormat = true;
        const v = arg.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') {
          usage = true;
          break;
        }
        format = v;
      } else if (arg === '--check') {
        if (seenCheck) {
          usage = true;
          break;
        }
        seenCheck = true;
        check = true;
      } else if (arg === '--strict') {
        if (seenStrict) {
          usage = true;
          break;
        }
        seenStrict = true;
        strict = true;
      } else {
        usage = true;
        break;
      }
      continue;
    }
    if (patch !== null) {
      usage = true;
      break;
    }
    patch = arg;
  }
  if (usage) {
    outLine('error: usage');
    return 2;
  }
  let text: string;
  if (patch === null || patch === '-') {
    text = readFileSync(0, 'utf8');
  } else {
    try {
      text = readFileSync(patch, 'utf8');
    } catch {
      outLine('error: no-patch');
      return 2;
    }
  }
  const lines = splitPatch(text);
  let effFormat = format ?? 'auto';
  if (effFormat === 'auto') {
    const d = detectFormat(lines);
    if (d === null) {
      outLine('error: format');
      return 2;
    }
    effFormat = d;
  }
  let edits: Applier[];
  try {
    if (effFormat === 'unified') edits = parseUnified(lines);
    else if (effFormat === 'search-replace') edits = parseSearchReplace(lines);
    else if (effFormat === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(lines);
  } catch (err) {
    if (err instanceof ParseFault) {
      outLine(`error: parse ${err.line}`);
      return 2;
    }
    throw err;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const e of edits) {
    const f = e(tree, strict);
    if (f !== null) fails.push(f);
  }
  if (fails.length > 0) {
    for (const f of fails) outLine(`error: ${f.code} ${f.path}`);
    outLine(`failed: ${fails.length} of ${edits.length} edits`);
    return 1;
  }
  if (!check) tree.writeAll();
  const changeLines = tree.changes();
  for (const l of changeLines) outLine(l);
  const n = changeLines.length;
  outLine(n === 1 ? 'ok: 1 file' : `ok: ${n} files`);
  return 0;
}

// Entry: with MAKEFUN_ENV_URL set, hand the trial over to the kit's runner; otherwise run the CLI.
const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl) {
  try {
    await runTrial(envUrl);
  } catch (err) {
    process.stderr.write(`runTrial failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
} else {
  process.exitCode = runCli();
}
