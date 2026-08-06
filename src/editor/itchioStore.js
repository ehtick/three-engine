/**
 * Whole-store browsing for the itch.io module. Every other function in
 * itchio.js only works because it's a per-account endpoint (your library,
 * your games) — itch.io has no public catalog/search API for reaching the
 * rest of the store. This fetches itch.io's own public browse/search HTML
 * pages (via the Rust `fetch_itchio_html` proxy, for the same CORS reasons
 * as every other integration here) and parses them client-side with the
 * browser's native `DOMParser`. No API key, no third-party service, no cost
 * — but also no contract: itch.io can change this markup at any time, and
 * (confirmed by hand while building this) itch.io starts returning HTTP 429
 * after a handful of rapid requests, so this is built for one request per
 * user action, never prefetching or looping.
 *
 * Markup reference (verified against the live site, subject to drift):
 *   <div class="game_cell" data-game_id="…">
 *     <div class="game_thumb"><a href="…"><img data-lazy_src="…"></a></div>
 *     <div class="game_cell_data">
 *       <div class="game_title">
 *         <a class="title game_link" href="…">Title</a>
 *         <a class="price_tag meta_tag"><div class="price_value">$X</div>
 *           <div class="sale_tag">-Y%</div></a>   <!-- absent when free -->
 *       </div>
 *       <div class="game_text" title="…">short description</div>
 *       <div class="game_author"><a href="…">Author</a></div>
 *     </div>
 *   </div>
 *
 * The `gameId` each cell carries (`data-game_id`) is the bridge back to the
 * real API: itch.io's `/games/{id}/uploads` + `/uploads/{id}/download` serve
 * *free* games to any valid API key without a download key, so a free item
 * found here can be imported in-editor by handing that id to
 * `fetchUploads`/`downloadAndImport` in itchio.js. Paid items are a hard stop
 * — there is no way to obtain files you haven't bought, and the panel routes
 * those to itch.io's own purchase page instead.
 */
async function invoke(cmd, args) {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke(cmd, args);
}

export const STORE_SORTS = [
  { id: "", label: "Default" },
  { id: "top-sellers", label: "Top sellers" },
  { id: "newest", label: "Newest" },
  { id: "top-rated", label: "Top rated" },
  { id: "on-sale", label: "On sale" },
  { id: "new-and-popular", label: "New & popular" },
  { id: "free", label: "Free only" },
];

const slugifyTag = (raw) =>
  raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Parses one `/game-assets…` or `/search…` result page into normalized items. */
function parseListing(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll(".game_cell")].map((cell) => {
    const titleLink = cell.querySelector(".game_title > a.title");
    const priceEl = cell.querySelector(".price_tag .price_value");
    const saleEl = cell.querySelector(".sale_tag");
    const authorLink = cell.querySelector(".game_author > a");
    const img = cell.querySelector(".game_thumb img");
    const textEl = cell.querySelector(".game_text");
    const gameId = Number(cell.getAttribute("data-game_id")) || null;
    return {
      id: cell.getAttribute("data-game_id") || titleLink?.getAttribute("href") || crypto.randomUUID(),
      // Numeric itch.io game id — the handle the API needs to list uploads.
      // Null if itch.io ever drops the attribute, in which case the panel
      // falls back to "open on itch.io" rather than guessing.
      gameId,
      title: titleLink?.textContent?.trim() || "Untitled",
      url: titleLink?.getAttribute("href") || null,
      author: authorLink?.textContent?.trim() || null,
      authorUrl: authorLink?.getAttribute("href") || null,
      coverUrl: img?.getAttribute("data-lazy_src") || img?.getAttribute("src") || null,
      description: textEl?.getAttribute("title") || textEl?.textContent?.trim() || "",
      price: priceEl?.textContent?.trim() || null,
      isFree: !priceEl,
      saleTag: saleEl?.textContent?.trim() || null,
    };
  });
}

async function fetchPage(url) {
  const html = await invoke("fetch_itchio_html", { url });
  return parseListing(html);
}

/**
 * Browses the game-assets category, optionally narrowed to one itch.io sort
 * (see STORE_SORTS) or one tag — itch.io's URL scheme takes one filter
 * segment at a time (`/game-assets/newest`, `/game-assets/tag-pixel-art`),
 * so `tag` wins over `sort` when both are set rather than guessing at an
 * unverified combined path.
 */
export async function browseStore({ sort = "", tag = "", page = 1 } = {}) {
  const segment = tag.trim() ? `tag-${slugifyTag(tag)}` : sort;
  const path = segment ? `/game-assets/${segment}` : "/game-assets";
  const url = `https://itch.io${path}${page > 1 ? `?page=${page}` : ""}`;
  const items = await fetchPage(url);
  return { items, nextPage: items.length > 0 ? page + 1 : null };
}

/**
 * Free-text search across the whole store (games and assets mixed — itch.io's
 * search has no classification filter as of this writing, unlike the
 * category browse above).
 */
export async function searchStore(query, page = 1) {
  const params = new URLSearchParams({ q: query });
  if (page > 1) params.set("page", String(page));
  const url = `https://itch.io/search?${params}`;
  const items = await fetchPage(url);
  return { items, nextPage: items.length > 0 ? page + 1 : null };
}

export async function openStoreItem(item) {
  if (!item.url) return;
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(item.url);
}
