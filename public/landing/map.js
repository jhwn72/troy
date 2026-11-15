// Troy landing: plays the free food map (#food-map).
// The picture itself is static SVG in index.html and its look is in map.css. This file only decides when it plays.
//
// Starts when the food conversation reaches Troy's "sending it to trojans nearby" line. That arrives as a
// "convo:step" event on the section's .convo mount, with the step from conversations.json as event.detail
// (or event.detail.step). If the conversation is not playing and sends no events, the map plays after it has been
// in view for four seconds. The section's replay button, or a "convo:start" with detail.replay, plays it again. With reduced motion nothing here runs and the finished map shows.

const TRIGGER = "sending it to trojans nearby";
const FALLBACK_MS = 4000;

const map = document.getElementById("food-map");
const section = map && map.closest("section");
const motionOk = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (map && section && motionOk) {
  let wanted = false;     // the trigger has happened and the map should play
  let playing = false;
  let visible = false;
  let sawEvents = false;  // the conversation script is dispatching, so the timer steps aside
  let timer = 0;

  const convo = section.querySelector(".convo");
  map.classList.add("is-armed");

  const play = () => {
    if (playing) return;
    playing = true;
    map.classList.add("is-playing");
  };

  const reset = () => {
    playing = false;
    wanted = false;
    map.classList.remove("is-playing");
    void map.offsetWidth; // so the same animations can run again
  };

  // Play only once the map is on screen (on phones it sits below the officer's phone).
  const request = () => {
    wanted = true;
    if (visible) play();
  };

  const armFallback = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // If the conversation is playing, its "sending it" line starts the map instead.
      const driven = sawEvents || (convo && convo.dataset.convoState === "playing");
      if (!driven && !playing && visible) request();
    }, FALLBACK_MS);
  };

  // A replayed conversation starts the map over. ("convo:start" carries detail.replay.)
  section.addEventListener("convo:start", (event) => {
    sawEvents = true;
    if (event.detail && event.detail.replay) reset();
  }, true);

  // Capture phase, so this hears the event on the .convo mount whether or not it bubbles.
  section.addEventListener("convo:step", (event) => {
    sawEvents = true;
    const detail = event.detail || {};
    const step = detail.step || detail;
    if (typeof step.text === "string" && step.text.includes(TRIGGER)) request();
  }, true);

  new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1].isIntersecting;
    if (!visible) {
      clearTimeout(timer);
    } else if (wanted) {
      play();
    } else if (!playing) {
      armFallback();
    }
  }, { threshold: 0.4 }).observe(map);

  const replay = section.querySelector(".replay");
  if (replay) {
    replay.addEventListener("click", () => {
      reset();
      sawEvents = false;
      // Wait a tick so a conversation script that restarts on this same click is seen first.
      setTimeout(() => { if (visible) armFallback(); }, 0);
    });
  }
}
