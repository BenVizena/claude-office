// Agent-set status lines ("speech bubbles"), one file per Claude Code session.
// { text, mood, needsYou, at, history: [{ text, mood, needsYou, at }] }
import fs from 'node:fs';
import path from 'node:path';
import { OFFICE_DIR, writeJsonAtomic, readJson } from './config.js';

export const STATUS_DIR = path.join(OFFICE_DIR, 'status');
fs.mkdirSync(STATUS_DIR, { recursive: true });
const MAX_TEXT = 120, MAX_HISTORY = 40;

function fileFor(session) {
  if (!/^[A-Za-z0-9-]+$/.test(session || '')) throw new Error('no Claude Code session id (is this running inside Claude Code?)');
  return path.join(STATUS_DIR, `${session}.json`);
}

function clean(t, max) {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  if (s.length > max) throw new Error(`keep it under ${max} characters — it's a speech bubble (use office-todo context for detail)`);
  return s;
}

export function readStatus(session) {
  try { return readJson(fileFor(session), null); } catch { return null; }
}

/** about: { board, item } when the office asks about a to-do item (its question lapses once that item is done). */
export function setStatus(session, { text, mood, needsYou, about }) {
  const file = fileFor(session);
  const cur = readJson(file, { history: [] });
  const entry = { text: clean(text, MAX_TEXT), at: Date.now() };
  if (!entry.text && !needsYou) throw new Error('give a status, e.g. office-todo status "Fixing the login redirect"');
  if (mood) entry.mood = clean(mood, 8);
  if (needsYou) entry.needsYou = clean(needsYou, 200);
  if (needsYou && about?.board && about?.item) entry.about = { board: String(about.board), item: String(about.item) };
  const history = [...(cur.history || []), entry].slice(-MAX_HISTORY);
  const next = { ...entry, history };
  writeJsonAtomic(file, next);
  return next;
}

export function clearStatus(session) {
  const file = fileFor(session);
  const cur = readJson(file, null);
  if (!cur) return null;
  const next = { history: cur.history || [], clearedAt: Date.now() };
  writeJsonAtomic(file, next);
  return next;
}

/** All statuses, keyed by session id. */
export function allStatuses() {
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(STATUS_DIR); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const v = readJson(path.join(STATUS_DIR, n), null);
    if (v) out.set(n.slice(0, -5), v);
  }
  return out;
}
