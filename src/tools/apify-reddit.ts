/**
 * Apify Reddit scraping — 6 search queries.
 * Replaces the Playwright Reddit research from systems-infrastructure.md.
 * Uses separate APIFY_TOKEN_REDDIT.
 * Budget: max 1,000 results total (~166 per search), ~$0.80 per launch.
 */

const APIFY_TOKEN_REDDIT = process.env.APIFY_TOKEN_REDDIT!;
const ACTOR_ID = "harshmaur/reddit-scraper";

interface RedditResult {
  title: string;
  text: string;
  subreddit: string;
  upvotes: number;
  url: string;
  comments: Array<{ text: string; upvotes: number }>;
}

async function startRedditRun(query: string, maxResults: number = 166): Promise<string> {
  const res = await fetch(
    // Apify API paths use the `username~actorname` form; a literal `/` in the slug
    // breaks the path and 404s the run-start call.
    `https://api.apify.com/v2/acts/${ACTOR_ID.replace("/", "~")}/runs?token=${APIFY_TOKEN_REDDIT}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searches: [query],
        maxItems: maxResults,
        sort: "relevance",
        proxy: { useApifyProxy: true },
      }),
    }
  );

  if (!res.ok) throw new Error(`Apify Reddit start failed: ${res.status}`);
  const data = (await res.json()) as { data: { id: string } };
  return data.data.id;
}

async function pollForCompletion(runId: string, timeoutMs: number = 300000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN_REDDIT}`
    );
    const data = (await res.json()) as { data: { status: string; defaultDatasetId: string } };
    const status = data.data.status;

    if (status === "SUCCEEDED") return data.data.defaultDatasetId;
    if (status === "FAILED" || status === "TIMED-OUT") {
      throw new Error(`Apify Reddit run ${status}`);
    }

    await new Promise((r) => setTimeout(r, 10000));
  }
  throw new Error("Apify Reddit run timed out");
}

async function fetchResults(datasetId: string): Promise<RedditResult[]> {
  const res = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN_REDDIT}&limit=200`
  );
  if (!res.ok) throw new Error(`Apify Reddit results failed: ${res.status}`);
  const data = (await res.json()) as Array<Record<string, unknown>>;

  return data.map((item: Record<string, unknown>) => ({
    title: (item.title || "") as string,
    text: (item.body || item.selftext || "") as string,
    subreddit: (item.subreddit || item.communityName || "") as string,
    upvotes: (item.upVotes || item.ups || 0) as number,
    url: (item.url || "") as string,
    comments: Array.isArray(item.comments)
      ? (item.comments as Array<Record<string, unknown>>).map((c) => ({
          text: (c.body || c.text || "") as string,
          upvotes: (c.upVotes || c.ups || 0) as number,
        }))
      : [],
  }));
}

/**
 * Run Reddit pain point mining.
 */
export async function runRedditResearch(
  category: string,
  competitor: string,
  icp: string
): Promise<string> {
  const searches = [
    `${category} frustrating`,
    `${competitor} sucks fees expensive`,
    `${competitor} alternative`,
    `best ${category} for ${icp}`,
    `"started a business" "${category}" nightmare`,
    `"quit my job" "${category}" tools`,
  ];

  const allResults: string[] = [];
  allResults.push("# Reddit Pain Point Research\n");

  for (const query of searches) {
    try {
      console.log(`[Reddit] Searching: "${query}"`);
      const runId = await startRedditRun(query, 166);
      const datasetId = await pollForCompletion(runId);
      const results = await fetchResults(datasetId);

      allResults.push(`\n## SEARCH: ${query}\n`);
      allResults.push(`Results: ${results.length}\n`);

      // Extract the best pain quotes
      for (const post of results.slice(0, 10)) {
        if (post.text) {
          allResults.push(
            `\nNUGGET: "${post.text.slice(0, 500)}"\n` +
              `SOURCE: Reddit r/${post.subreddit} | ${post.upvotes} upvotes\n` +
              `TAGS: [PAIN]\n` +
              `USABLE FOR: [Body pain setup / Weapons upgrade]\n`
          );
        }
        // Top comments as nuggets
        for (const comment of post.comments.slice(0, 3)) {
          if (comment.text && comment.upvotes > 5) {
            allResults.push(
              `\nNUGGET: "${comment.text.slice(0, 300)}"\n` +
                `SOURCE: Reddit r/${post.subreddit} comment | ${comment.upvotes} upvotes\n` +
                `TAGS: [PAIN]\n` +
                `USABLE FOR: [Hook pain / Body enemy line]\n`
            );
          }
        }
      }
    } catch (err) {
      console.error(`[Reddit] Failed: "${query}"`, err);
      allResults.push(`\n## SEARCH: ${query}\nFAILED: ${err instanceof Error ? err.message : "Unknown"}\n`);
    }
  }

  return allResults.join("\n");
}
