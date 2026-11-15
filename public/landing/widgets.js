// Troy landing: the small widgets. Repair steps, engine examples and the FAQ accordion.
// Looks are in page.css and widgets.css. This file only switches classes and attributes.

const motionOk = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const FALLBACK_MS = 4000;

/* ---------- Repair steps: Reported, On it, Fixed ---------- */
// Each step turns laurel green (li.is-done) as its text lands in the broken-things conversation. Those arrive as
// "convo:step" events on the section's .convo mount, with the step from conversations.json as event.detail
// (or event.detail.step). If no such events arrive, the steps run on a timer once they have been in view four seconds.
// With reduced motion page.css already shows all three green, so nothing runs.

const steps = document.querySelector(".repair-steps");
const broken = steps && steps.closest("section");

if (steps && broken && motionOk) {
  const order = ["reported", "on-it", "fixed"];
  const items = order.map((name) => steps.querySelector(`li[data-step="${name}"]`));
  const convo = broken.querySelector(".convo");
  let sawEvents = false;
  let visible = false;
  let timers = [];

  // Marking a step also marks the ones before it.
  const mark = (name) => {
    const upTo = order.indexOf(name);
    items.forEach((li, i) => { if (li && i <= upTo) li.classList.add("is-done"); });
  };
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };
  const reset = () => {
    clearTimers();
    items.forEach((li) => li && li.classList.remove("is-done"));
  };
  const allDone = () => items.every((li) => !li || li.classList.contains("is-done"));

  const stepFor = (step) => {
    if (order.includes(step.repair) && step.repair !== "reported") return step.repair;
    const text = typeof step.text === "string" ? step.text : "";
    if (text.includes("facilities is on it")) return "on-it";
    if (text.startsWith("fixed")) return "fixed";
    // Reported: the student's own report landing on their phone.
    if (step.phone === "left" && step.from === "me" && text) return "reported";
    if (step.repair === "reported") return "reported";
    return "";
  };

  // A replayed conversation starts the steps over. ("convo:start" carries detail.replay.)
  broken.addEventListener("convo:start", (event) => {
    sawEvents = true;
    if (event.detail && event.detail.replay) reset();
  }, true);

  // Capture phase, so this hears the event on the .convo mount whether or not it bubbles.
  broken.addEventListener("convo:step", (event) => {
    if (!sawEvents) { sawEvents = true; clearTimers(); }
    const detail = event.detail || {};
    const name = stepFor(detail.step || detail);
    if (name) mark(name);
  }, true);

  const armFallback = () => {
    clearTimers();
    timers.push(setTimeout(() => {
      const driven = sawEvents || (convo && convo.dataset.convoState === "playing");
      // Inside the pinned day scene the conversation always drives the steps.
      if (driven || !visible || allDone() || document.documentElement.classList.contains("day-on")) return;
      order.forEach((name, i) => timers.push(setTimeout(() => { if (!sawEvents) mark(name); }, i * 1600)));
    }, FALLBACK_MS));
  };

  new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1].isIntersecting;
    if (visible && !sawEvents && !allDone()) armFallback();
  }, { threshold: 0.5 }).observe(steps);

  // The day scene showing this stop without a conversation to play (the data did not load): show it finished.
  window.addEventListener("day:settle", (event) => {
    if (event.detail && event.detail.key === "broken") mark("fixed");
  });

  const replay = broken.querySelector(".replay");
  if (replay) {
    replay.addEventListener("click", () => {
      reset();
      sawEvents = false;
      // Wait a tick so a conversation script that restarts on this same click is seen first.
      setTimeout(() => { if (visible) armFallback(); }, 0);
    });
  }
}

/* ---------- Engine: tap, focus or hover a circle to see its example ---------- */
// Hover and keyboard focus are handled in CSS. A tap or click sets .is-open on one step at a time;
// a second tap, a tap anywhere else or Escape closes it.

const engineSteps = [...document.querySelectorAll(".engine-step")];
const engineButton = (step) => step.querySelector("button.engine-circle");

const closeEngine = (except) => {
  engineSteps.forEach((step) => {
    if (step === except) return;
    step.classList.remove("is-open");
    const button = engineButton(step);
    if (button) button.setAttribute("aria-expanded", "false");
  });
};

engineSteps.forEach((step) => {
  const button = engineButton(step);
  if (!button || !step.querySelector(".engine-example")) return;
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", (event) => {
    const open = !step.classList.contains("is-open");
    closeEngine(step);
    step.classList.toggle("is-open", open);
    button.setAttribute("aria-expanded", String(open));
    // A pointer tap on an open step closes it, so drop the focus that would keep it showing.
    // Keyboard presses (detail 0) keep focus where it is.
    if (!open && event.detail > 0) button.blur();
  });
});

// On phones the circles sit in one row and the chosen step's title and line show under it,
// so there the steps without an example can be chosen with a tap too.
const engineRow = window.matchMedia("(max-width: 767px)");
engineSteps.forEach((step) => {
  if (engineButton(step)) return;
  const circle = step.querySelector(".engine-circle");
  if (!circle) return;
  circle.addEventListener("click", () => {
    if (!engineRow.matches) return;
    const open = !step.classList.contains("is-open");
    closeEngine(step);
    step.classList.toggle("is-open", open);
  });
});

if (engineSteps.length) {
  document.addEventListener("click", (event) => {
    const onCircle = event.target.closest(engineRow.matches ? ".engine-step .engine-circle" : ".engine-step button.engine-circle");
    if (!onCircle) closeEngine(null);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeEngine(null);
  });
}

/* ---------- FAQ: native details, one open at a time ---------- */

const faqItems = [...document.querySelectorAll(".faq details")];

faqItems.forEach((item) => {
  // Opening one closes the others.
  item.addEventListener("toggle", () => {
    if (!item.open) return;
    faqItems.forEach((other) => {
      if (other !== item && other.open) other.open = false;
    });
  });
});
