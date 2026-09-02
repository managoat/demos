/**
 * Teammate names (after OpenMausBot's bot names): a curated list beats a
 * naming API — instant, offline, friendly, short. Avoids names in use;
 * when the pool is exhausted it numbers a base name.
 */
const NAMES = [
  "Scout", "Pixel", "Atlas", "Nova", "Juno", "Koda", "Miso", "Mochi",
  "Biscuit", "Pepper", "Clover", "Ember", "Willow", "Comet", "Orbit", "Echo",
  "Indigo", "Sage", "Zephyr", "Poppy", "Maple", "Cosmo", "Luna", "Otto",
  "Ivy", "Finch", "Wren", "Basil", "Hazel", "Nimbus", "Onyx", "Pearl",
  "Quill", "Rocket", "Sunny", "Tango", "Vega", "Ziggy", "Fig", "Juniper",
  "Moss", "Pebble", "Rio", "Skye", "Ursa", "Yuki", "Kiwi", "Plum", "Sprout",
];

export function pickName(taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  const free = NAMES.filter((n) => !used.has(n.toLowerCase()));
  if (free.length) return free[Math.floor(random() * free.length)]!;
  const base = NAMES[Math.floor(random() * NAMES.length)]!;
  for (let i = 2; ; i++) if (!used.has(`${base.toLowerCase()} ${i}`)) return `${base} ${i}`;
}
