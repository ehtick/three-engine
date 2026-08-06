/**
 * Playback for the editor's own transport. The second and last place Web Audio
 * appears.
 *
 * Deliberately dumb: it plays one buffer, from an offset, optionally looping,
 * and reports where the playhead is. It does not mix — the document's mixdown
 * is computed by `auddoc.mixdown` in plain JS and handed here as one buffer, so
 * what you hear is exactly what gets written to the file. Building a Web Audio
 * graph that mirrored the track stack would mean two mixers that have to agree,
 * and the one you can't inspect would be the one people trust.
 *
 * The playhead is derived from `context.currentTime`, never from a timer.
 * `setInterval` drifts against the audio clock, and a playhead that drifts is
 * worse than no playhead: it points at the wrong sample precisely when someone
 * is trying to find an edit point by ear.
 */
import { audioContext, toAudioBuffer } from "./decode.js";

export function createPlayer() {
  let source = null;
  let gainNode = null;
  let startedAtContextTime = 0;
  let startedFromSeconds = 0;
  let playingDuration = 0;
  let looping = false;
  let onStateChange = null;

  const context = () => audioContext();

  const teardown = () => {
    if (source) {
      try { source.onended = null; source.stop(); } catch {}
      try { source.disconnect(); } catch {}
    }
    if (gainNode) {
      try { gainNode.disconnect(); } catch {}
    }
    source = null;
    gainNode = null;
  };

  return {
    get playing() {
      return !!source;
    },

    /**
     * Where the playhead is, in seconds. Valid while playing; after a stop the
     * caller keeps its own position, because there is no source left to ask.
     */
    position() {
      const ctx = context();
      if (!source || !ctx) return startedFromSeconds;
      const elapsed = ctx.currentTime - startedAtContextTime;
      if (looping && playingDuration > 0) return startedFromSeconds + (elapsed % playingDuration);
      return Math.min(startedFromSeconds + elapsed, playingDuration);
    },

    /**
     * Plays `pcm` from `fromSeconds`. `loopRange` (in seconds) auditions a
     * selection on repeat, which is how a loop point is judged — you cannot
     * hear whether a seam clicks by playing past it once.
     */
    async play(pcm, { fromSeconds = 0, loop = false, loopRange = null, volume = 1, onEnded = null } = {}) {
      const ctx = context();
      if (!ctx) return false;
      // Every browser starts the context suspended until a gesture; the click
      // that triggered this counts, but only if we actually resume.
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      teardown();

      const buffer = toAudioBuffer(pcm, ctx);
      source = ctx.createBufferSource();
      source.buffer = buffer;
      gainNode = ctx.createGain();
      gainNode.gain.value = volume;
      source.connect(gainNode);
      gainNode.connect(ctx.destination);

      looping = !!loop || !!loopRange;
      if (loopRange) {
        source.loop = true;
        source.loopStart = Math.max(0, loopRange[0]);
        source.loopEnd = Math.max(source.loopStart + 0.001, loopRange[1]);
        playingDuration = source.loopEnd - source.loopStart;
        startedFromSeconds = source.loopStart;
      } else {
        source.loop = looping;
        playingDuration = buffer.duration;
        startedFromSeconds = Math.max(0, Math.min(fromSeconds, buffer.duration));
      }

      source.onended = () => {
        // `stop()` also fires onended; the guard keeps a manual stop from
        // being reported to the caller as "playback finished".
        if (!source) return;
        teardown();
        onStateChange?.();
        onEnded?.();
      };

      startedAtContextTime = ctx.currentTime;
      source.start(0, startedFromSeconds);
      onStateChange?.();
      return true;
    },

    stop() {
      if (!source) return;
      teardown();
      onStateChange?.();
    },

    setVolume(value) {
      if (gainNode) gainNode.gain.value = Math.max(0, value);
    },

    /** Called whenever playback starts or stops, so the UI can re-render. */
    subscribe(fn) {
      onStateChange = fn;
      return () => {
        if (onStateChange === fn) onStateChange = null;
      };
    },

    dispose: teardown,
  };
}
