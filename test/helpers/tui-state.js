// A fixed office model for the terminal renderer's tests: the shape buildOffice (server/office.js) returns, built
// with the same layout functions, with no clock and no files so every render of it is the same.
import { roomSize, placeRooms, LOBBY } from '../../public/shared/layout.js';

let n = 0;
const session = (title, status, extra = {}) => ({
  id: `s${++n}`, agent: 'claude', title, status, statusDetail: null, background: false, lastActivity: 1000 - n,
  contextPct: 0.3, tokens: { total: 1000 * n }, claims: [], ...extra,
});
const says = (text, needsYou = null) => ({ agentStatus: { text, mood: '🔧', needsYou, history: [] } });
const pod = (path, branch, sessions, extra = {}) => ({ key: path.toLowerCase(), path, branch, isMain: false, removed: false, seats: 6, sessions, ...extra });

function room(key, name, pods, decorItems = []) {
  return { key, kind: 'project', name, pods, size: roomSize(pods.length, pods.map((p) => p.seats)), todos: [], decor: { theme: {}, items: decorItems } };
}

export function demoState() {
  n = 0;
  const rooms = [
    { key: 'lobby', kind: 'lobby', name: 'Lobby', size: { w: LOBBY.w, d: LOBBY.d, cols: 0, rows: 0 }, pods: [], todos: [],
      decor: { theme: {}, items: [{ id: 'sofa', item: 'sofa', x: 4.2, z: 11.6, rot: 180, scale: 1 }, { id: 'rug', item: 'rug_round', x: 4.2, z: 9.6, rot: 0, scale: 1 }, { id: 'plant', item: 'plant_tall', x: 0.7, z: 12.2, rot: 0, scale: 1 }] } },
    room('api-server-1a2b3c', 'api-server', [
      pod('/work/api-server', 'main', [
        session('Fix the login redirect', 'working', says('Tracking down the redirect loop, 2 suspects left')),
        session('Review the auth PR', 'idle'),
        session('Rate limiter rewrite', 'needs_you', { statusDetail: 'wants to use Bash', ...says('Blocked on the cache question', 'Drop the old cache, or migrate it?') }),
        session('Old spike', 'gone'),
      ], { isMain: true }),
      pod('/work/api-server/.claude/worktrees/billing', 'feature/billing', [
        session('Add invoices endpoint', 'working', { agent: 'pi', background: true, ...says('Running the tests again') }),
        session('Write the migration', 'compacting'),
      ]),
    ], [{ id: 'plant_corner', item: 'plant_tall', x: 0.8, z: 0.8, rot: 0, scale: 1 }, { id: 'shelf', item: 'bookshelf', x: 16.55, z: 6.5, rot: 270, scale: 1 }, { id: 'sofa', item: 'sofa', x: 3, z: 11.5, rot: 180, scale: 1 }, { id: 'art', item: 'painting', wall: 'left', along: 9.2, y: 1.7 }]),
    room('docs-site-4d5e6f', 'docs-site', [
      pod('/work/docs-site', 'main', [session('Rewrite the quickstart', 'away')], { isMain: true }),
    ]),
    room('game-engine-778899', 'game-engine', [
      pod('/work/game-engine', 'main', [
        session('Physics step profiler', 'working', says('Profiling the broadphase')),
        session('Untitled session', 'idle'),
      ], { isMain: true }),
      pod('/work/game-engine/.claude/worktrees/renderer', 'renderer-v2', Array.from({ length: 8 }, (_, i) => session(`Shader pass ${i + 1}`, i < 5 ? 'working' : 'idle')), { seats: 8 }),
      pod('/work/game-engine/.claude/worktrees/office-ab12cd-1', 'office/ab12cd', [session('Step: port the audio mixer', 'working', { background: true })], { step: { id: 'ab12cd', text: 'Port the audio mixer', phase: 'working', run: 'r1' } }),
      pod('/work/game-engine/.claude/worktrees/old', 'old-experiment', [], { removed: true }),
    ]),
  ];
  const pos = placeRooms(rooms.map((r) => ({ key: r.key, w: r.size.w, d: r.size.d })));
  for (const r of rooms) r.pos = pos.get(r.key);
  return { now: 0, rooms, catalog: [], staff: {}, todoBoards: [], checksRunning: [], settings: {} };
}
