// Troy landing: the drawn campus map (#food-map), the stage of "A day at USC".
// The picture is static SVG in index.html and its look is in map.css. This file only sets attributes.
//
// The map has one layer per stop (g.map-layer[data-layer]). Two things drive it:
//   1. Which stop is current: day.js dispatches "day:stop" on window; the map gets data-stop="<key>" and that
//      stop's layer cross-fades in.
//   2. How far that stop's story has got: steps in conversations.json carry "map": 1, 2 or 3. They arrive as
//      "convo:step" events (detail { key, step }); the layer gets data-phase and map.css shows what belongs to it.
//      "convo:start" puts the layer back to phase 0.
// The free food layer keeps its own sequence (pin, 15-minute circle, dots one by one): phase 1 adds .is-playing.
// Without the pinned scene (reduced motion, no JavaScript) nothing here runs and the finished food map shows.

const KEYS = ["lost-found", "concern", "food", "broken", "rides"];
const FOOD_TRIGGER = "sending it to trojans nearby";

const root = document.documentElement;
const map = document.getElementById("food-map");

if (map && root.classList.contains("day-on")) {
  const layers = {};
  for (const layer of map.querySelectorAll(".map-layer[data-layer]")) layers[layer.dataset.layer] = layer;

  const setPhase = (key, phase) => {
    const layer = layers[key];
    if (!layer) return;
    if (phase == null) delete layer.dataset.phase;      // finished
    else layer.dataset.phase = String(phase);
    if (key !== "food") return;
    const playing = phase == null || phase >= 1;
    if (!playing && map.classList.contains("is-playing")) {
      map.classList.remove("is-playing");
      void map.offsetWidth; // so the same animations can run again
    } else if (playing) {
      map.classList.add("is-playing");
    }
  };

  map.classList.add("is-armed");
  for (const key of Object.keys(layers)) setPhase(key, 0);

  const showStop = (index) => {
    const key = KEYS[index];
    if (key && map.dataset.stop !== key) map.dataset.stop = key;
  };
  showStop(Number(root.dataset.dayStop || 0));
  window.addEventListener("day:stop", (event) => showStop(event.detail.index));

  // Capture phase, so this hears the events on the .convo mounts whether or not they bubble.
  document.addEventListener("convo:start", (event) => {
    const key = event.detail && event.detail.key;
    if (layers[key]) setPhase(key, 0);
  }, true);

  document.addEventListener("convo:step", (event) => {
    const detail = event.detail || {};
    const step = detail.step || {};
    if (!layers[detail.key]) return;
    if (step.map != null) setPhase(detail.key, step.map);
    else if (detail.key === "food" && typeof step.text === "string" && step.text.includes(FOOD_TRIGGER)) setPhase("food", 1);
  }, true);

  // A stop shown without a conversation to play (the data did not load): show its finished picture.
  window.addEventListener("day:settle", (event) => {
    if (event.detail) setPhase(event.detail.key, null);
  });
}
