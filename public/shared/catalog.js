// Built-in decor catalog metadata. Geometry builders live in public/js/catalog-builders.js.
// footprint: [width (x), depth (z)] in world units (~1 unit = 1 metre).
// mount: 'floor' items stand on the floor; 'wall' items hang on the back or left wall.

export const BUILTIN_CATALOG = [
  { id: 'plant_tall', name: 'Tall fiddle-leaf plant', tags: ['plant', 'green', 'natural'], footprint: [0.8, 0.8], height: 2.0, mount: 'floor', colorable: true, defaultColor: '#d9cbb5' },
  { id: 'plant_small', name: 'Small potted plant', tags: ['plant', 'green'], footprint: [0.5, 0.5], height: 0.8, mount: 'floor', colorable: true, defaultColor: '#ffffff' },
  { id: 'monstera', name: 'Monstera in woven basket', tags: ['plant', 'tropical'], footprint: [1.1, 1.1], height: 1.4, mount: 'floor', colorable: true, defaultColor: '#c9a978' },
  { id: 'cactus', name: 'Cactus', tags: ['plant', 'desert'], footprint: [0.5, 0.5], height: 1.1, mount: 'floor', colorable: true, defaultColor: '#e07a5f' },
  { id: 'sofa', name: 'Three-seat sofa', tags: ['seating', 'lounge', 'cozy'], footprint: [2.4, 1.0], height: 0.9, mount: 'floor', colorable: true, defaultColor: '#a8c5b5' },
  { id: 'armchair', name: 'Armchair', tags: ['seating', 'lounge'], footprint: [1.0, 1.0], height: 0.9, mount: 'floor', colorable: true, defaultColor: '#e8b4a0' },
  { id: 'beanbag', name: 'Bean bag', tags: ['seating', 'casual', 'fun'], footprint: [1.0, 1.0], height: 0.6, mount: 'floor', colorable: true, defaultColor: '#f2cc8f' },
  { id: 'coffee_table', name: 'Round coffee table', tags: ['table', 'lounge'], footprint: [1.0, 1.0], height: 0.45, mount: 'floor', colorable: true, defaultColor: '#c8a27a' },
  { id: 'side_table', name: 'Side table', tags: ['table'], footprint: [0.5, 0.5], height: 0.55, mount: 'floor', colorable: true, defaultColor: '#ffffff' },
  { id: 'rug_round', name: 'Round rug', tags: ['rug', 'soft'], footprint: [2.4, 2.4], height: 0.02, mount: 'floor', colorable: true, defaultColor: '#e9d8c4', flat: true },
  { id: 'rug_rect', name: 'Rectangular rug', tags: ['rug', 'soft'], footprint: [3.0, 2.0], height: 0.02, mount: 'floor', colorable: true, defaultColor: '#b8c9d9', flat: true },
  { id: 'floor_lamp', name: 'Arc floor lamp', tags: ['light', 'lamp', 'cozy'], footprint: [0.6, 0.6], height: 1.9, mount: 'floor', colorable: true, defaultColor: '#222222' },
  { id: 'bookshelf', name: 'Bookshelf', tags: ['storage', 'books', 'library'], footprint: [1.6, 0.4], height: 2.0, mount: 'floor', colorable: true, defaultColor: '#f4efe6' },
  { id: 'cabinet_low', name: 'Low sideboard', tags: ['storage'], footprint: [1.8, 0.5], height: 0.7, mount: 'floor', colorable: true, defaultColor: '#d8c3a5' },
  { id: 'water_cooler', name: 'Water cooler', tags: ['kitchen', 'office'], footprint: [0.5, 0.5], height: 1.3, mount: 'floor', colorable: false },
  { id: 'coffee_bar', name: 'Coffee bar counter', tags: ['kitchen', 'coffee', 'cafe'], footprint: [2.0, 0.7], height: 1.0, mount: 'floor', colorable: true, defaultColor: '#ffffff' },
  { id: 'arcade', name: 'Arcade cabinet', tags: ['fun', 'games', 'retro'], footprint: [0.8, 0.8], height: 1.8, mount: 'floor', colorable: true, defaultColor: '#6c5ce7' },
  { id: 'aquarium', name: 'Aquarium on stand', tags: ['fish', 'calm', 'water'], footprint: [1.4, 0.5], height: 1.4, mount: 'floor', colorable: true, defaultColor: '#2d2d2d' },
  { id: 'record_player', name: 'Record player console', tags: ['music', 'retro'], footprint: [1.2, 0.5], height: 0.9, mount: 'floor', colorable: true, defaultColor: '#8d6e63' },
  { id: 'guitar', name: 'Guitar on stand', tags: ['music'], footprint: [0.5, 0.5], height: 1.1, mount: 'floor', colorable: true, defaultColor: '#c0392b' },
  { id: 'globe', name: 'Desk globe on stand', tags: ['decor', 'travel', 'library'], footprint: [0.6, 0.6], height: 1.1, mount: 'floor', colorable: false },
  { id: 'pouf', name: 'Knitted pouf', tags: ['seating', 'cozy'], footprint: [0.6, 0.6], height: 0.4, mount: 'floor', colorable: true, defaultColor: '#bfa6d9' },
  { id: 'painting', name: 'Abstract painting', tags: ['art', 'wall'], footprint: [1.4, 0.06], height: 1.0, mount: 'wall', colorable: true, defaultColor: '#f2cc8f' },
  { id: 'poster', name: 'Framed poster', tags: ['art', 'wall'], footprint: [0.8, 0.04], height: 1.1, mount: 'wall', colorable: true, defaultColor: '#81b29a' },
  { id: 'wall_clock', name: 'Wall clock', tags: ['wall', 'time'], footprint: [0.6, 0.06], height: 0.6, mount: 'wall', colorable: true, defaultColor: '#ffffff' },
  { id: 'wall_shelf', name: 'Floating shelf with trinkets', tags: ['wall', 'storage'], footprint: [1.4, 0.3], height: 0.5, mount: 'wall', colorable: true, defaultColor: '#c8a27a' },
  { id: 'neon_sign', name: 'Neon squiggle sign', tags: ['wall', 'light', 'fun'], footprint: [1.2, 0.05], height: 0.6, mount: 'wall', colorable: true, defaultColor: '#ff6fb5' },
  { id: 'hanging_plant', name: 'Wall planter with trailing vines', tags: ['wall', 'plant'], footprint: [0.6, 0.3], height: 0.9, mount: 'wall', colorable: true, defaultColor: '#ffffff' },
  { id: 'window', name: 'Tall window', tags: ['wall', 'light', 'view'], footprint: [1.6, 0.1], height: 2.0, mount: 'wall', colorable: true, defaultColor: '#ffffff' },
];

// Door signs over each room's front doorway (theme.sign). The designer picks these.
export const SIGN_STYLES = ['neon', 'brass', 'wood', 'marquee', 'chalkboard'];
export const SIGN_FONTS = {
  sans: '700 {px}px "Segoe UI", "Helvetica Neue", Arial, sans-serif',
  script: '700 {px}px "Segoe Script", "Brush Script MT", "Snell Roundhand", cursive',
  serif: '700 {px}px Georgia, "Times New Roman", serif',
  mono: '700 {px}px Consolas, "Courier New", monospace',
  display: '{px}px Impact, "Arial Black", "Franklin Gothic Heavy", sans-serif',
  rounded: '700 {px}px "Arial Rounded MT Bold", "Varela Round", "Segoe UI", sans-serif',
};

export const FLOOR_STYLES = ['wood', 'light_wood', 'concrete', 'tile', 'carpet', 'terrazzo'];

// What you see through the windows. The decorator can change it per room.
export const VIEWS = {
  meadow: 'rolling green hills, wildflowers and a few trees under a bright sky',
  mountains: 'snow-capped mountain ranges and pine trees',
  lake: 'a calm alpine lake reflecting the mountains',
  forest: 'a deep green pine forest',
  city: 'a modern city skyline on a clear day',
  sunset_city: 'a city skyline at golden-hour sunset',
  beach: 'a turquoise sea, white sand and a palm tree',
  desert: 'warm desert dunes, mesas and a cactus',
  snow: 'a snowy winter landscape with falling snow',
  cherry_blossom: 'pink cherry blossom trees in spring',
  rainy: 'a soft grey rainy day',
  night_sky: 'a starry night with a crescent moon over hills',
  space: 'outer space with a ringed planet and stars',
  underwater: 'an underwater reef with fish and bubbles',
};

export const DEFAULT_THEME = { floorStyle: 'light_wood', floor: '#e9dcc7', wall: '#f7f5f0', accent: '#9fc3b0', view: 'meadow' };
