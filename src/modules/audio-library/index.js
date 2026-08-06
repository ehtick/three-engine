/**
 * Audio Library.
 *
 * Editor-only, like the other asset-library browsers: enabling it turns on a
 * panel that searches Freesound and Wikimedia Commons for game sound effects
 * and ambience, auditions them in place, and imports the chosen file into
 * `<project>/Audio/`. Nothing here ships inside an exported game — an imported
 * sound is an ordinary asset that keeps working whether or not the module
 * stays enabled.
 *
 * Freesound needs a free API key (instant, no payment details); Commons needs
 * nothing at all, so the panel is useful before any key exists. Every import
 * appends to `Audio/CREDITS.md`, because a CC-BY sound used without credit is
 * a licence breach nobody notices until the game ships.
 */
export const audioLibraryModule = {
  id: "audio-library",
  name: "Audio Library",
  category: "Editor",
  tags: ["editor-import", "assets", "audio", "sfx", "ambience", "freesound", "cc0"],
  description:
    "Search free game SFX and ambience from Freesound and Wikimedia Commons, audition results in the editor, and import them into the project with licences recorded automatically.",
  version: "1.0.0",
  components: [],
  async setup() {
    return {};
  },
};
