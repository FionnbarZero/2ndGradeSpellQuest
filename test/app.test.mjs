import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as engine from "../dist/engine.js";
import { CURRENT_WEEK } from "../dist/curriculum.js";

// Exercise the real app handlers with isolated DOM/audio/timer doubles.
// No browser profile, saved child data, or microphone service is involved.
function fixture() {
  const nodes = new Map();
  const intervals = new Map();
  const timeouts = new Map();
  const memory = new Map();
  let nextTimer = 1;
  const speech = { cancelled: 0, spoken: [], getVoices: () => [], addEventListener() {},
    cancel() { this.cancelled++; }, speak(u) { this.spoken.push(u.text); } };
  function node(key) {
    if (!nodes.has(key)) nodes.set(key, {
      innerHTML: "", textContent: "", value: "", open: false, events: {}, dataset: {},
      classList: { add() {}, remove() {} },
      addEventListener(e, fn) { this.events[e] = fn; }, querySelector: node, querySelectorAll: () => [],
      focus() {}, setAttribute() {}, append() {}, select() {},
      showModal() { this.open = true; }, close() { this.open = false; }, content: { cloneNode() {} },
    });
    return nodes.get(key);
  }
  const context = vm.createContext({ ...engine, CURRENT_WEEK,
    document: { querySelector: node, addEventListener() {} },
    localStorage: { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v) },
    window: {
      speechSynthesis: speech,
      SpeechRecognition: class { start() {} abort() {} },
      setTimeout(fn) { const id = nextTimer++; timeouts.set(id, fn); return id; },
      clearTimeout: id => timeouts.delete(id),
      setInterval(fn) { const id = nextTimer++; intervals.set(id, fn); return id; },
      clearInterval: id => intervals.delete(id),
      scrollTo() {}, location: { protocol: "https:" },
    },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
  });
  const source = readFileSync(new URL("../dist/app.js", import.meta.url), "utf8")
    .replace(/^import[\s\S]*?from "\.\/engine.js";\n/, "")
    .replace(/^import .*curriculum.js";\n/m, "");
  const run = code => vm.runInContext(code, context);
  run(source);
  return { node, run, speech, intervals,
    tick() { for (const fn of [...intervals.values()]) fn(); },
    flushTimeouts() { const callbacks = [...timeouts.values()]; timeouts.clear(); callbacks.forEach(fn => fn()); },
  };
}

test("closing a problem report resumes the correction countdown", () => {
  const f = fixture();
  f.run('startDay("monday"); startTeaching(currentStage()); renderCorrection(true);');
  f.tick();
  f.node("#report-problem-button").events.click();
  for (let i = 0; i < 8; i++) f.tick();
  assert.equal(f.node("#countdown span").textContent, "3");
  f.node("#problem-close").events.click();
  for (let i = 0; i < 3; i++) f.tick();
  assert.match(f.node("#app").innerHTML, /Build with a guide/);
  assert.equal(f.intervals.size, 0);
});

test("memory preview stays paused in a report and resumes after dismissal", () => {
  const f = fixture();
  f.run('startDay("monday"); startTeaching(currentStage()); session.currentTask.level = 2; session.previewComplete = false; renderTeachingTask();');
  f.node("#report-problem-button").events.click();
  for (let i = 0; i < 8; i++) f.tick();
  assert.equal(f.run("session.previewComplete"), false);
  f.node("#problem-dialog").close(); // Also covers Escape/native dismissal.
  for (let i = 0; i < 5; i++) f.tick();
  assert.equal(f.run("session.previewComplete"), true);
});

test("microphone stops playing and scheduled narration and suppresses letter echo", () => {
  const f = fixture();
  f.run('startDay("monday"); startTeaching(currentStage()); speakWord("air"); schedulePrompt(() => speakWord("air"), 350);');
  const cancelled = f.speech.cancelled;
  f.speech.spoken.length = 0;
  f.run("startVoiceLetters();");
  assert.ok(f.speech.cancelled > cancelled);
  f.flushTimeouts();
  f.run('speakLetterSequence(["a"]);');
  assert.deepEqual(f.speech.spoken, []);
});

test("explicit listening works muted without enabling automatic sounds", () => {
  const f = fixture();
  f.run('muted = true; bindListenButtons("air");');
  f.node("[data-speak-word]").events.click();
  assert.equal(f.speech.spoken.length, 1);
  f.node("[data-speak-sentence]").events.click();
  assert.equal(f.speech.spoken.length, 2);
  f.run('speakWord("air"); speakLetterSequence(["a"]);');
  assert.equal(f.speech.spoken.length, 2);
  assert.equal(f.run("muted"), true);
});

test("sentence form retains incomplete answers and advances a complete example", () => {
  const f = fixture();
  f.run('startDay("tuesday"); startSentencePractice(currentStage());');
  const submit = () => f.node("#sentence-practice-form").events.submit({ preventDefault() {} });
  f.node("#sentence-practice-input").value = "air";
  submit();
  for (const answer of ["air", "air air.", "The air is cool"]) {
    f.node("#sentence-practice-input").value = answer;
    submit();
    assert.equal(f.run("session.sentencePractice.index"), 0);
    assert.equal(f.node("#sentence-practice-input").value, answer);
    assert.notEqual(f.node("#sentence-feedback").textContent, "");
  }
  f.node("#sentence-practice-input").value = "The air is cool.";
  submit();
  assert.equal(f.run("session.sentencePractice.index"), 1);
});

test("wrong spoken letters leave the answer empty, correct letters fill it in order", () => {
  const f = fixture();
  f.run('startDay("monday"); startTeaching(currentStage()); session.currentTask.word = "here"; session.currentTask.level = 4; prepareLetters();');
  f.run('startVoiceLetters(); recognition.onresult({results: [[{transcript: "H E A R"}]]});');
  assert.equal(f.run("session.builtTileIds.length"), 0);
  f.run('startVoiceLetters(); recognition.onresult({results: [[{transcript: "H E R E"}]]});');
  assert.equal(f.run('session.builtTileIds.map(id => session.letterTiles.find(t => t.id === id).letter).join("")'), "here");
});
