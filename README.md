# 2nd Grade SpellQuest

2nd Grade SpellQuest is a browser-based spelling and sentence-writing tutor driven by the class's weekly focus. It combines scaffolded letter activities, sentence practice, delayed tests, child-led self-scoring, targeted Thursday reteaching, and a local progress graph.

## Current curriculum

The week of October 5–9 comes from the classroom deck **26-27 G2 Weekly Focus**.

- **Red words used in this spelling game:** air, means, years, here
- **General Academic reading targets saved for a future reading game:** eager, explained, soldiers, message, change

The source identifiers and both word groups are stored in `dist/curriculum.js`. They are bundled into the static game so the child does not need access to the private Google Slides deck.

## Weekly sequence

- **Monday:** Teach all four red words with the five-step spelling sequence, then complete an immediate word check.
- **Tuesday:** Spell each red word from a visible prompt, then use it in a sentence.
- **Wednesday:** Spell each red word again, then use it in a new sentence.
- **Thursday:** Complete a delayed spelling test of all four words. Any missed word is retaught and retested that day.

## Learning sequence

Each new word progresses through:

1. Visible unscramble
2. Five-second memory unscramble
3. Independent unscramble
4. Voice-controlled unscramble
5. Typed spelling
6. Delayed-feedback test and self-scoring

Previously practiced words are interleaved at Level 5 while the four words are learned. Two errors at a level move the word back one level. Test results are stored only in the current browser. Tuesday and Wednesday sentences remain in the active session and are not saved after the page is closed.

Every correct teaching answer earns a visible Spell Spark with a short magical chime. The running total stays beside the lesson progress, and the learner uses the collected sparks to charge the spellbook at the end of the teaching sequence before beginning the word check. The chime follows the app's Sound on/off control.

## Run locally

```sh
npm run serve
```

Then open <http://localhost:4173>.

## Test

```sh
npm test
```

The app has no runtime dependencies. Voice input uses the browser's Speech Recognition API when available and provides a clearly labeled keyboard fallback when it is not.

For microphone spelling, open the game from an HTTPS address or run `npm run serve` and use the localhost URL. Opening `dist/index.html` directly as a `file://` page can prevent Chrome from granting reliable microphone access. The voice step distinguishes permission, microphone, network, and no-speech failures and always keeps letter tiles available.

Every screen includes a **Report a problem** button. It prepares a privacy-conscious diagnostic prompt and opens a new repository-aware Codex chat using the documented `codex://` deep-link scheme. The reporter reviews and sends the message; reports are never submitted silently. A clipboard fallback is included for devices without the Codex desktop app.

Audio prompts begin with “Spell [word],” and each lowercase letter is spoken as the learner places a tile or types. The app prefers Chrome's Google US English voice when it is available and otherwise chooses a natural English voice installed on the device. On computer keyboards, Enter submits typed spelling and advances eligible instruction, feedback, and result screens.
