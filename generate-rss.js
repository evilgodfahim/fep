const fs   = require("fs");
const axios = require("axios");
const cheerio = require("cheerio");
const RSS  = require("rss");

const baseURL         = "https://today.thefinancialexpress.com.bd";
const targetURL       = baseURL;
const flareSolverrURL = process.env.FLARESOLVERR_URL || "http://localhost:8191";

fs.mkdirSync("./feeds", { recursive: true });

// ===== DATE PARSING =====
// The FE Today homepage shows the edition date in the header as plain text:
//   "Monday, 1 June 2026"
// There are no per-article timestamps on the front page, so every item gets
// the edition date (or now() as a safe fallback).
function parseEditionDate(html) {
  // Matches patterns like "Monday, 1 June 2026" or "Sunday, 31 May 2026"
  const match = html.match(
    /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+\d{1,2}\s+\w+\s+\d{4}/i
  );
  if (match) {
    const d = new Date(match[0]);
    if (!isNaN(d.getTime())) return d;
  }
  console.warn("⚠️  Could not parse edition date from page — using now()");
  return new Date();
}

// ===== FLARESOLVERR =====
async function fetchWithFlareSolverr(url) {
  console.log(`Fetching ${url} via FlareSolverr...`);
  const response = await axios.post(
    `${flareSolverrURL}/v1`,
    { cmd: "request.get", url, maxTimeout: 60000 },
    { headers: { "Content-Type": "application/json" }, timeout: 65000 }
  );
  if (response.data?.solution) {
    console.log("✅ FlareSolverr successfully bypassed protection");
    return response.data.solution.response;
  }
  throw new Error("FlareSolverr did not return a solution");
}

// ===== MAIN =====
async function generateRSS() {
  try {
    const htmlContent = await fetchWithFlareSolverr(targetURL);
    const $           = cheerio.load(htmlContent);
    const editionDate = parseEditionDate(htmlContent);
    const items       = [];
    const seenLinks   = new Set();

    // ── Section tracking ──────────────────────────────────────────────────────
    // Each section is structured as:
    //   <div class="row">
    //     <div class="col-lg-12">
    //       <h2 class="text-center">SECTION NAME</h2>
    //     </div>
    //   </div>
    //   <div class="row home-section"">   ← note the typo (extra quote) is in the source
    //     <div class="col-lg-4">
    //       <div class="has-post">
    //         <a href="..." class="local-news"> ... </a>
    //         <p>snippet</p>            ← text-only card: p is outside the <a>
    //       </div>
    //     </div>
    //     ...
    //   </div>
    //
    // For image+text cards the layout inside <a> is:
    //   <div class="row">
    //     <div class="col-lg-5"><h4><img ...></h4></div>
    //     <div class="col-lg-7"><h4>TITLE</h4><p>snippet</p></div>
    //   </div>
    //
    // For text-only cards the layout inside <a> is just:
    //   <h4>TITLE</h4>
    // …and the <p> snippet sits as a sibling of <a> inside .has-post.

    $("div.has-post").each((_, postEl) => {
      const $post = $(postEl);
      const $a    = $post.find("a.local-news").first();

      if (!$a.length) return;

      const href = $a.attr("href")?.trim();
      if (!href) return;

      // All hrefs in this page are already absolute.
      const link = href.startsWith("http") ? href : baseURL + href;
      if (seenLinks.has(link)) return;
      seenLinks.add(link);

      // ── Title ──────────────────────────────────────────────────────────────
      // Image-cards: first h4 wraps <img>, second h4 is the title.
      // Text-cards:  single h4 is the title.
      // Strategy: prefer the h4 that does NOT contain an <img>.
      let title = "";
      $a.find("h4").each((_, h4) => {
        if (!$(h4).find("img").length) {
          title = $(h4).text().replace(/\s+/g, " ").trim();
          return false; // break — take the first non-image h4
        }
      });
      if (!title) return; // skip if we genuinely can't find a title

      // ── Description/snippet ───────────────────────────────────────────────
      // Two locations depending on card type:
      //   1. Inside <a> → .col-lg-7 > p  (image-card)
      //   2. Sibling of <a> inside .has-post → p  (text-card)
      let description =
        $a.find(".col-lg-7 p").first().text().replace(/\s+/g, " ").trim() ||
        $post.find("> p").first().text().replace(/\s+/g, " ").trim() ||
        $post.children("p").first().text().replace(/\s+/g, " ").trim();

      // ── Section ───────────────────────────────────────────────────────────
      // Walk up to the closest .row.home-section, then look at the
      // immediately preceding .row sibling for the h2 heading.
      const $homeSection = $post.closest("div.home-section");
      let section = "";
      if ($homeSection.length) {
        // prev() skips empty text nodes via cheerio
        const $headingRow = $homeSection.prev("div.row");
        section = $headingRow.find("h2.text-center").first().text().trim();
      }

      items.push({
        title,
        link,
        description,
        section,
        date: editionDate,
      });
    });

    console.log(`Found ${items.length} articles`);

    if (items.length === 0) {
      console.warn("⚠️  No articles found — check selectors or page structure");
      items.push({
        title:       "No articles found",
        link:        baseURL,
        description: "RSS feed could not scrape any articles.",
        section:     "",
        date:        new Date(),
      });
    }

    const feed = new RSS({
      title:       "The Financial Express – Today's Paper",
      description: "All articles from today's edition of The Financial Express (Bangladesh)",
      feed_url:    targetURL,
      site_url:    baseURL,
      language:    "en",
      pubDate:     editionDate.toUTCString(),
    });

    items.forEach(item => {
      feed.item({
        title:       item.section ? `[${item.section}] ${item.title}` : item.title,
        url:         item.link,
        description: item.description || undefined,
        date:        item.date,
      });
    });

    fs.writeFileSync("./feeds/feed.xml", feed.xml({ indent: true }));
    console.log(`✅ RSS generated with ${items.length} items.`);

  } catch (err) {
    console.error("❌ Error generating RSS:", err.message);

    const feed = new RSS({
      title:       "The Financial Express – Today's Paper (error fallback)",
      description: "RSS feed could not scrape, showing placeholder",
      feed_url:    targetURL,
      site_url:    baseURL,
      language:    "en",
      pubDate:     new Date().toUTCString(),
    });
    feed.item({
      title:       "Feed generation failed",
      url:         baseURL,
      description: "An error occurred during scraping.",
      date:        new Date(),
    });
    fs.writeFileSync("./feeds/feed.xml", feed.xml({ indent: true }));
  }
}

generateRSS();
