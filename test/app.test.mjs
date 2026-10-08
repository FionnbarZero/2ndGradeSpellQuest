import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as engine from "../dist/engine.js";
import { CURRENT_WEEK } from "../dist/curriculum.js";

// Exercise the real app handlers with isolated DOM/audio/timer doubles.
// No browser profile, saved child data, or microphone service is involved.
function fixture(options = {}) {
  const nodes = new Map();
  const intervals = new Map();
  const timeouts = new Map();
  const memory = options.memory ?? new Map();
  const temporary = options.temporary ?? new Map();
  let nextTimer = 1;
  const speech = { cancelled: 0, spoken: [], utterances: [], paused: Boolean(options.pausedSpeech),
    resume() { this.paused = false; }, getVoices: () => options.voices || [], addEventListener(event, callback) { this[event] = callback; },
    cancel() { this.cancelled++; }, speak(u) { this.spoken.push(u.text); this.utterances.push(u); if (!options.silentSpeech) u.onstart?.(); } };
  function node(key, owner) {
    if (!nodes.has(key)) nodes.set(key, {
      owner, _html: "", textContent: "", value: "", open: false, events: {}, listeners: {}, dataset: {},
      get innerHTML() { return this._html; },
      set innerHTML(html) {
        this._html = html;
        if (key === "#app") for (const element of nodes.values()) {
          if (element.owner === "#app") { element.events = {}; element.listeners = {}; element.value = ""; }
        }
      },
      classList: { add() {}, remove() {} },
      addEventListener(e, fn) {
        (this.listeners[e] ??= []).push(fn);
        this.events[e] = (event = {}) => { for (const listener of [...this.listeners[e]]) listener(event); };
      }, querySelector: selector => node(selector, key === "#app" ? "#app" : owner), querySelectorAll: () => [],
      focus() { this.focused = true; }, setAttribute() {}, append() {}, select() {}, insertAdjacentHTML(_where, html) { this._html += html; },
      showModal() { this.open = true; }, close() { this.open = false; }, content: { cloneNode() {} },
    });
    return nodes.get(key);
  }
  const context = vm.createContext({ ...engine, CURRENT_WEEK,
    document: { querySelector: node, addEventListener() {} },
    localStorage: { getItem: k => { if (options.blockRead) throw new Error("SecurityError"); return memory.get(k) ?? null; }, setItem: (k, v) => { if (options.blockWrite) throw new Error("QuotaExceededError"); memory.set(k, v); }, removeItem: k => memory.delete(k) },
    sessionStorage: { getItem: k => { if (options.blockTemporary) throw new Error("SecurityError"); return temporary.get(k) ?? null; }, setItem: (k, v) => { if (options.blockTemporary) throw new Error("QuotaExceededError"); temporary.set(k, v); }, removeItem: k => temporary.delete(k) },
    window: {
      speechSynthesis: speech,
      SpeechRecognition: class { start() {} abort() {} },
      setTimeout(fn) { const id = nextTimer++; timeouts.set(id, fn); return id; },
      clearTimeout: id => timeouts.delete(id),
      setInterval(fn) { const id = nextTimer++; intervals.set(id, fn); return id; },
      clearInterval: id => intervals.delete(id),
      scrollTo() {}, confirm: () => true, addEventListener() {}, location: { protocol: "https:" },
    },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
  });
  const source = readFileSync(new URL("../dist/app.js", import.meta.url), "utf8")
    .replace(/^import[\s\S]*?from "\.\/engine.js";\n/, "")
    .replace(/^import .*curriculum.js";\n/m, "");
  const run = code => vm.runInContext(code, context);
  if (options.noSpeech) run("delete window.speechSynthesis;");
  run(source);
  return { node, run, speech, intervals, memory, temporary,
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

test("resuming a learning screen automatically reads its word again", () => {
  const f = fixture();
  f.run('startDay("monday"); startTeaching(currentStage());');
  const r = fixture({ temporary: f.temporary });
  r.run('resumeLesson();');
  assert.equal(r.speech.spoken.length, 1);
  assert.match(r.speech.spoken[0], /^Write the word air\./);
});

test("turning Sound on reads the current learning word without a Hear click", () => {
  const f = fixture({ memory: new Map([["spellcraft-sound-v1", "muted"]]) });
  f.run('startDay("monday"); startTeaching(currentStage());');
  f.node("#sound-button").events.click();
  assert.equal(f.speech.spoken.length, 1);
});

test("a paused browser speech engine is resumed before queuing the word", () => {
  const f = fixture({ pausedSpeech: true });
  f.run('startDay("monday"); startTeaching(currentStage());');
  assert.equal(f.speech.paused, false);
});

test("a browser that silently fails to start speech reports failure instead of pretending it played", () => {
  const f = fixture({ silentSpeech: true });
  f.run('startDay("thursday"); startTest(currentStage());');
  f.flushTimeouts();
  assert.equal(f.run("narrationFailed"), true);
  assert.match(f.node("#narration-status").textContent, /browser did not start the voice/);
  f.node("#test-input").value = "air";
  f.node("#test-form").events.submit({ preventDefault() {} });
  assert.equal(f.run("session.test.index"), 0);
});

test("memory preview reads the word immediately and a stale start timeout cannot affect another screen", () => {
  const f = fixture({ silentSpeech: true });
  f.run('startDay("monday"); startTeaching(currentStage()); session.currentTask.level = 2; session.previewComplete = false; renderTeachingTask();');
  assert.match(f.speech.spoken.at(-1), /^Write the word air\./);
  f.run('stopActivity();');
  f.flushTimeouts();
  assert.equal(f.run("narrationFailed"), false);
});

test("practice opens every spelling prompt immediately without pressing Hear the word", () => {
  for (const day of ["tuesday", "wednesday"]) {
    const f = fixture();
    f.run(`startDay("${day}");`);
    f.node("#primary-action").events.click();
    for (const word of CURRENT_WEEK.spellingTargets) {
      assert.match(f.speech.spoken.at(-1), new RegExp(`^Write the word ${word}\\.`));
      const count = f.speech.spoken.length;
      f.flushTimeouts();
      assert.equal(f.speech.spoken.length, count, "no delayed duplicate prompt");
      assert.equal(f.node("#sentence-practice-input").focused, true);
      f.node("#sentence-practice-input").value = word;
      f.node("#sentence-practice-form").events.submit({ preventDefault() {} });
      f.node("#sentence-practice-input").value = `I can write ${word}.`;
      f.node("#sentence-practice-form").events.submit({ preventDefault() {} });
    }
    assert.equal(f.speech.spoken.length, 4);
  }
});

test("every test question speaks in its opening action, with no delayed duplicate", () => {
  const f = fixture();
  f.run('startDay("thursday");');
  f.node("#primary-action").events.click();
  for (const word of CURRENT_WEEK.spellingTargets) {
    assert.match(f.speech.spoken.at(-1), new RegExp(`^Write the word ${word}\\.`));
    const count = f.speech.spoken.length;
    f.flushTimeouts();
    assert.equal(f.speech.spoken.length, count);
    assert.equal(f.node("#test-input").focused, true);
    f.node("#test-input").value = word;
    f.node("#test-form").events.submit({ preventDefault() {} });
  }
  assert.equal(f.speech.spoken.length, 4);
});

test("automatic teaching and test prompts respect intentional Sound off", () => {
  for (const day of ["monday", "tuesday", "thursday"]) {
    const f = fixture({ memory: new Map([["spellcraft-sound-v1", "muted"]]) });
    f.run(`startDay("${day}");`);
    f.node("#primary-action").events.click();
    f.flushTimeouts();
    assert.equal(f.speech.spoken.length, 0);
  }
});

test("voice settings persist, load late voices, and use natural speed by default", () => {
  const voices = [{ name: "Samantha", lang: "en-US" }, { name: "Google US English", lang: "en-US" }];
  const options = { voices };
  const f = fixture(options);
  f.run('speakWord("means");');
  assert.equal(f.speech.utterances.at(-1).voice, voices[1]);
  assert.equal(f.speech.utterances.at(-1).rate, 1);
  f.node("#voice-choice").events.change({ target: { value: "Samantha|en-US" } });
  f.node("#voice-rate").events.change({ target: { value: "0.85" } });
  f.run('speakWord("means");');
  assert.equal(f.speech.utterances.at(-1).voice, voices[0]);
  assert.equal(f.speech.utterances.at(-1).rate, 0.85);
  const rOptions = { memory: f.memory, voices: [] };
  const r = fixture(rOptions);
  assert.match(r.node("#voice-status").textContent, /saved voice is unavailable/);
  rOptions.voices = voices;
  r.speech.voiceschanged();
  r.run('speakWord("means");');
  assert.equal(r.speech.utterances.at(-1).voice, voices[0]);
  assert.equal(r.speech.utterances.at(-1).rate, 0.85);
});

test("voice preview does not clear a failed test prompt or enable automatic sound", () => {
  const f = fixture();
  f.run('muted = true; narrationFailed = true;');
  f.node("#voice-preview").events.click();
  assert.equal(f.speech.spoken.length, 1);
  f.speech.utterances.at(-1).onend();
  assert.equal(f.run("narrationFailed"), true);
  assert.equal(f.run("muted"), true);
});

test("utterances stay referenced until completion, failure, or cancellation", () => {
  const f = fixture();
  f.run('speakWord("means");');
  assert.equal(f.run("activeUtterances.size"), 1);
  f.speech.utterances.at(-1).onstart();
  assert.match(f.node("#narration-status").textContent, /Listen to the word/);
  f.speech.utterances.at(-1).onend();
  assert.equal(f.run("activeUtterances.size"), 0);
  f.run('speakWord("means");');
  f.speech.utterances.at(-1).onerror({ error: "synthesis-failed" });
  assert.equal(f.run("activeUtterances.size"), 0);
  f.run('speakWord("means");');
  f.node("#sound-button").events.click();
  assert.equal(f.run("activeUtterances.size"), 0);
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

const oldScore = { id: "old", day: "monday", completedAt: "2026-10-01T12:00:00Z", score: 3, total: 4, percent: 75, testType: "immediate", responses: [{word:"air",answer:"air"}] };

test("blocked persistent storage does not prevent startup or finishing a test", () => {
  const f = fixture({blockRead:true,blockWrite:true});
  assert.match(f.node("#app").innerHTML, /Choose your day/);
  f.run('startDay("thursday");startTest(currentStage());session.test.responses=[{word:"air",answer:"air"}];finishTest();');
  assert.match(f.node("#app").innerHTML, /Every spell matched/);
  assert.equal(f.run("getHistory().length"),1);
  assert.match(f.node("#storage-status").textContent,/could not be saved/);
});

test("malformed history is preserved before saving valid results", () => {
  for (const raw of ['null','{"length":1}','{broken',JSON.stringify([oldScore,{bad:true}])]) {
    const memory=new Map([["spellquest-history-v2",raw]]);
    const f=fixture({memory});
    assert.match(f.node("#app").innerHTML,/Choose your day/);
    f.run('startDay("thursday");startTest(currentStage());session.test.responses=[{word:"air",answer:"air"}];finishTest();');
    const backup=[...memory].find(([key])=>key.startsWith('spellquest-history-v2-recovery-'));
    assert.equal(backup?.[1],raw);
    if(raw.includes('"old"')) assert.equal(f.run('getHistory().some(e=>e.id==="old")'),true);
  }
});

test("backup failure never overwrites damaged history", () => {
  const memory=new Map([["spellquest-history-v2","null"]]);
  const f=fixture({memory,blockWrite:true});
  f.run('saveHistory([]);');
  assert.equal(memory.get("spellquest-history-v2"),"null");
});

test("valid legacy scores survive alongside new daily completion without sentence text", () => {
  const f=fixture({memory:new Map([["spellquest-history-v2",JSON.stringify([oldScore])]])});
  f.run('startDay("tuesday");startSentencePractice(currentStage());session.sentencePractice.responses=[{word:"air",sentence:"PRIVATE DRAFT",spelling:"air"}];session.sentencePractice.index=4;renderSentencePracticeComplete();');
  assert.equal(f.run('getHistory().length'),2);
  assert.equal(f.run('getHistory()[0].id'),"old");
  assert.equal(f.memory.get("spellquest-history-v2").includes("PRIVATE DRAFT"),false);
  assert.match(f.node("#app").innerHTML,/Grammar and meaning have not been checked/);
  f.node("#adult-reviewed").events.change({target:{checked:true}});
  assert.equal(f.run('getHistory().at(-1).adultReviewed'),true);
  assert.equal(f.run('getHistory().length'),2);
});

test("sentence drafts restore in the same tab but never enter persistent history", () => {
  const f=fixture();
  f.run('startDay("wednesday");startSentencePractice(currentStage());session.sentencePractice.step="sentence";session.sentencePractice.spelling="air";renderSentencePractice();');
  f.node("#sentence-practice-input").value="The air is cool.";
  f.node("#sentence-practice-input").events.input();
  const reloaded=fixture({memory:f.memory,temporary:f.temporary});
  assert.match(reloaded.node("#app").innerHTML,/Resume lesson/);
  reloaded.run('resumeLesson();');
  assert.match(reloaded.node("#app").innerHTML,/The air is cool\./);
  assert.equal(reloaded.run('session.sentencePractice.step'),"sentence");
  assert.equal([...f.memory.values()].join().includes("The air is cool."),false);
  reloaded.run('renderDayComplete();');
  assert.equal(f.temporary.has("spellquest-session-v1"),false);
});

test("teaching resumes with shared task references and the same ordered tiles", () => {
  const f=fixture();
  f.run('startDay("monday");startTeaching(currentStage());addSpokenLetter("a");renderTeachingTask();');
  const reloaded=fixture({temporary:f.temporary});
  reloaded.run('resumeLesson();');
  assert.equal(reloaded.run('session.currentTask === currentStage().runtimeTasks[session.taskIndex]'),true);
  assert.equal(reloaded.run('session.builtTileIds.map(id=>session.letterTiles.find(t=>t.id===id).letter).join("")'),"a");
});

test("test draft and self-scoring resume without duplicating saved results", () => {
  const f=fixture();
  f.run('startDay("thursday");startTest(currentStage());');
  f.node("#test-input").value="air";f.node("#test-input").events.input();
  let r=fixture({temporary:f.temporary,memory:f.memory});r.run('resumeLesson();');
  assert.match(r.node("#app").innerHTML,/value="air"/);
  r.run('session.test.responses=currentStage().words.map(word=>({word,answer:word}));session.test.index=4;session.test.selfScoreIndex=2;renderSelfScoring();');
  r=fixture({temporary:f.temporary,memory:f.memory});r.run('resumeLesson();');
  assert.equal(r.run('session.test.selfScoreIndex'),2);
  r.run('session.test.selfScoreIndex=4;finishTest();');
  r=fixture({temporary:f.temporary,memory:f.memory});r.run('resumeLesson();');
  assert.equal(r.run('getHistory().length'),1);
  assert.equal(r.run('session.view'),"result");
});

test("blocked temporary storage still permits in-page resume with a warning", () => {
  const f=fixture({blockTemporary:true});
  f.run('startDay("monday");startTeaching(currentStage());');
  f.node("#home-button").events.click();
  assert.match(f.node("#app").innerHTML,/Resume lesson/);
  assert.match(f.node("#storage-status").textContent,/Temporary saving is unavailable/);
  f.run('resumeLesson();');
  assert.match(f.node("#app").innerHTML,/Build with a guide/);
});

test("checkpoints from another curriculum week are not resumed", () => {
  const f=fixture();f.run('startDay("monday");');
  const saved=JSON.parse(f.temporary.get("spellquest-session-v1"));saved.weekId="2025-01-01";
  f.temporary.set("spellquest-session-v1",JSON.stringify(saved));
  const r=fixture({temporary:f.temporary});
  assert.doesNotMatch(r.node("#app").innerHTML,/id="resume-lesson"/);
});

test("every recognition failure enables tiles and stale callbacks are ignored", () => {
  for(const error of ["language-not-supported","no-speech","network","not-allowed","audio-capture","aborted"]) {
    const f=fixture();
    f.run('startDay("monday");startTeaching(currentStage());session.currentTask.level=4;renderTeachingTask();startVoiceLetters();');
    const callback=f.run('recognition.onerror');callback({error});
    assert.equal(f.run('session.voiceFallback'),true);
    assert.doesNotMatch(f.node("#app").innerHTML,/disabled aria-label="Letter/);
    f.node("#home-button").events.click();
    assert.doesNotThrow(()=>callback({error}));
    assert.match(f.node("#app").innerHTML,/Choose your day/);
  }
});

test("recognition ending without a result clears the listening state", () => {
  const f=fixture();
  f.run('startDay("monday");startTeaching(currentStage());session.currentTask.level=4;renderTeachingTask();startVoiceLetters();recognition.onend();');
  assert.equal(f.run('recognition'),null);
  assert.equal(f.run('session.voiceFallback'),true);
  assert.match(f.run('session.voiceStatus'),/Listening ended/);
});

test("missing narration preserves the test answer until an adult reads the prompt", () => {
  const f=fixture({noSpeech:true});
  f.run('startDay("thursday");startTest(currentStage());');
  const submit=()=>f.node("#test-form").events.submit({preventDefault(){}});
  f.node("#test-input").value="air";submit();
  assert.equal(f.run('session.test.index'),0);
  assert.match(f.node("#narration-status").textContent,/Your answer has not been marked/);
  f.node("#adult-prompt-read").events.click();submit();
  assert.equal(f.run('session.test.index'),1);
  assert.equal(f.run('session.test.adultPromptReady'),false);
});

test("narration errors show recovery and a successful replay restores audio", () => {
  const f=fixture();f.run('startDay("thursday");startTest(currentStage());speakWord("air",true);');
  f.speech.utterances.at(-1).onerror({error:"synthesis-failed"});
  assert.equal(f.run('narrationFailed'),true);
  f.run('speakWord("air",true);');f.speech.utterances.at(-1).onend();
  assert.equal(f.run('narrationFailed'),false);
  const stale=f.speech.utterances.at(-1).onerror;
  f.run('stopSpeech();');stale({error:"synthesis-failed"});
  assert.equal(f.run('narrationFailed'),false);
});

test("Thursday offers only one optional extra round and retains unresolved words", () => {
  const f=fixture();
  f.run('startDay("thursday");startTest(currentStage());session.test.responses=currentStage().words.map(word=>({word,answer:word==="air"?"wrong":word}));session.test.index=4;finishTest();');
  assert.equal(f.run('session.stages.length'),3);
  f.run('session.stageIndex=2;startTest(currentStage());session.test.responses=[{word:"air",answer:"wrong"}];session.test.index=1;finishTest();');
  assert.match(f.node("#app").innerHTML,/Try one extra practice round/);
  f.node("#extra-practice").events.click();
  assert.equal(f.run('session.stages.length'),5);
  f.run('session.stageIndex=4;startTest(currentStage());session.test.responses=[{word:"air",answer:"wrong"}];session.test.index=1;finishTest();');
  assert.doesNotMatch(f.node("#app").innerHTML,/id="extra-practice"/);
  f.run('advanceStage();');
  assert.match(f.node("#app").innerHTML,/not yet mastered/);
  assert.equal(f.run('unresolvedWords(getHistory()).join(",")'),"air");
});

test("a successful targeted retest clears only its word from unresolved status", () => {
  const f=fixture();
  f.run('startDay("thursday");startTest(currentStage());session.test.responses=currentStage().words.map(word=>({word,answer:"wrong"}));session.test.index=4;finishTest();session.stageIndex=2;startTest(currentStage());session.test.responses=[{word:"air",answer:"air"}];session.test.index=1;finishTest();');
  assert.equal(f.run('unresolvedWords(getHistory()).join(",")'),"means,years,here");
});

test("progress separates full checks, retests and practice and escapes historical text", () => {
  const f=fixture();
  const history=[oldScore,{...oldScore,id:"targeted",testType:"retest",score:0,total:1,percent:0,weekId:"<img>",responses:[{word:"<script>",answer:"wrong"}]}, {id:"practice",kind:"practice",weekId:CURRENT_WEEK.id,day:"tuesday",completedAt:oldScore.completedAt,adultReviewed:false}];
  const html=f.run(`renderGraph(${JSON.stringify(history)})`);
  assert.match(html,/Full spelling checks/);assert.match(html,/Targeted retests/);assert.match(html,/Daily practice/);
  assert.match(html,/not recorded in older score/);assert.match(html,/Sentences not adult-reviewed/);
  assert.doesNotMatch(html,/<script>|<img>|polyline|NaN/);
});

test("tile focus is retained near the activity after rerendering", () => {
  const f=fixture();f.run('startDay("monday");startTeaching(currentStage());addSpokenLetter("a");renderTeachingTask(true);focusTile();');
  f.flushTimeouts();
  assert.equal(f.node('[data-add-tile]:not(:disabled)').focused,true);
  assert.equal(f.node('#activity-status').textContent,'Your letters: a.');
});

test("reporting a problem or hearing the word stops recording and restores tiles", () => {
  for (const action of ["report", "listen"]) {
    const f=fixture();
    f.run('startDay("monday");startTeaching(currentStage());session.currentTask.level=4;renderTeachingTask();startVoiceLetters();');
    if(action === "report") {
      f.node("#report-problem-button").events.click();
      f.node("#problem-close").events.click();
    } else f.node("[data-speak-word]").events.click();
    assert.equal(f.run("recognition"),null);
    assert.equal(f.run("session.voiceFallback"),true);
    assert.match(f.node("#app").innerHTML,/Microphone stopped/);
    assert.doesNotMatch(f.node("#app").innerHTML,/disabled aria-label="Letter/);
  }
});

test("microphone constructor failure leaves working fallback controls", () => {
  const f=fixture();
  f.run('startDay("monday");startTeaching(currentStage());session.currentTask.level=4;window.SpeechRecognition=class{constructor(){throw new Error("unavailable")}};startVoiceLetters();');
  assert.equal(f.run("session.voiceFallback"),true);
  assert.match(f.node("#app").innerHTML,/could not be set up/);
});

test("a stored teaching intro regenerates its lesson definitions", () => {
  const f=fixture();f.run('startDay("monday");');
  const saved=JSON.parse(f.temporary.get("spellquest-session-v1"));
  delete saved.session.stages[0].tasks;
  f.temporary.set("spellquest-session-v1",JSON.stringify(saved));
  const r=fixture({temporary:f.temporary});r.run('resumeLesson();');
  assert.doesNotThrow(()=>r.node("#primary-action").events.click());
  assert.equal(r.run('currentStage().runtimeTasks.length'),29);
});

test("storage access recovery merges earlier unread scores instead of replacing them", () => {
  const memory=new Map([["spellquest-history-v2",JSON.stringify([oldScore])]]);
  const options={memory,blockRead:true};
  const f=fixture(options);
  options.blockRead=false;
  f.run('startDay("thursday");startTest(currentStage());session.test.responses=currentStage().words.map(word=>({word,answer:word}));session.test.index=4;finishTest();');
  const saved=JSON.parse(memory.get("spellquest-history-v2"));
  assert.equal(saved.length,2);assert.equal(saved[0].id,"old");
  assert.equal(f.run('getHistory().length'),2);
});

test("read-denied but write-allowed storage never overwrites unread history", () => {
  const memory=new Map([["spellquest-history-v2",JSON.stringify([oldScore])]]);
  const f=fixture({memory,blockRead:true});
  f.run('startDay("thursday");startTest(currentStage());session.test.responses=[{word:"air",answer:"air"}];finishTest();');
  assert.deepEqual(JSON.parse(memory.get("spellquest-history-v2")),[oldScore]);
  assert.equal(f.run('getHistory().length'),1);
});

test("incomplete checkpoints cannot create completed practice or a partial full-test score", () => {
  for(const kind of ["practice","test"]) {
    const f=fixture();
    if(kind === "practice") f.run('startDay("tuesday");startSentencePractice(currentStage());session.view="sentence-complete";saveCheckpoint();');
    else f.run('startDay("thursday");startTest(currentStage());session.test.responses=[{word:"air",answer:"air"}];session.test.index=1;session.test.selfScoreIndex=1;session.view="self-score";saveCheckpoint();');
    const r=fixture({temporary:f.temporary,memory:f.memory});
    assert.doesNotMatch(r.node("#app").innerHTML,/id="resume-lesson"/);
    assert.equal(r.run('getHistory().length'),0);
    assert.match(r.node("#storage-status").textContent,/could not be restored/);
  }
});
