/**
 * Audio Editor.
 *
 * Editor-only, like the Texture Editor: enabling it turns on a multitrack
 * waveform editor over the project's sound files. Nothing here ships inside an
 * exported game.
 *
 * What it authors deliberately does not live in it. The `.audio` sidecar,
 * `SoundComponent`, `ListenerComponent` and the whole `AudioSystem` are core
 * engine — a shipped game must play a sound without a project having enabled a
 * tool called "Audio Editor". What this module gates is the authoring surface:
 * the track stack (a hidden `.aud` sidecar beside each sound, exactly as `.tex`
 * sits beside each image), the edits, and the processing that follows.
 */
export const audioEditorModule = {
  id: "audio-editor",
  name: "Audio Editor",
  category: "Editor",
  tags: ["editor-tool", "audio", "sfx", "waveform", "multitrack"],
  description:
    "Edit sounds inside the editor: layer takes on separate tracks with gain/pan/mute/solo, cut, trim, silence, duplicate and reverse with sample-accurate zero-crossing snapping, then mix down to the file your scene already references.",
  version: "1.0.0",
  components: [],
  async setup() {
    return {};
  },
};
