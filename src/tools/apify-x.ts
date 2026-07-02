/**
 * Apify X/Twitter scraping — 5-run design.
 * Replaces the curl calls from systems-infrastructure.md.
 */

const APIFY_TOKEN = process.env.APIFY_TOKEN!;
const ACTOR_ID = "scrape.badger/twitter-tweets-scraper";

interface TweetResult {
  text: string;
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  author: string;
  followers: number;
  verified: boolean;
  date: string;
  hasMedia: boolean;
}

async function startActorRun(query: string, maxTweets: number = 1000): Promise<string> {
  const res = await fetch(
    // Apify API paths use the `username~actorname` form; a literal `/` in the slug
    // breaks the path and 404s the run-start call.
    `https://api.apify.com/v2/acts/${ACTOR_ID.replace("/", "~")}/runs?token=${APIFY_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // This actor keys off `mode`. Without it the run defaults to
      // "Get Tweet by ID" and fails with "Missing 'id' parameter". Advanced
      // Search accepts full Twitter search operators (min_faves:, since:, filters).
      body: JSON.stringify({
        mode: "Advanced Search",
        query,
        count: maxTweets,
        max_results: maxTweets,
      }),
    }
  );

  if (!res.ok) throw new Error(`Apify start failed: ${res.status}`);
  const data = (await res.json()) as { data: { id: string } };
  return data.data.id;
}

async function pollForCompletion(runId: string, timeoutMs: number = 300000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
    );
    const data = (await res.json()) as { data: { status: string; defaultDatasetId: string } };
    const status = data.data.status;

    if (status === "SUCCEEDED") return data.data.defaultDatasetId;
    if (status === "FAILED" || status === "TIMED-OUT") {
      throw new Error(`Apify run ${status}`);
    }

    await new Promise((r) => setTimeout(r, 10000)); // Poll every 10s
  }
  throw new Error("Apify run timed out");
}

async function fetchResults(datasetId: string): Promise<TweetResult[]> {
  const res = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=1000`
  );
  if (!res.ok) throw new Error(`Apify results failed: ${res.status}`);
  const data = (await res.json()) as Array<Record<string, unknown>>;

  // This actor returns FLAT fields (username, user_followers_count, …), not the
  // nested `user`/`public_metrics` objects of the Twitter API. Map accordingly.
  return data.map(
    (t: Record<string, unknown>) => ({
      text: (t.full_text || t.text || "") as string,
      likes: (t.favorite_count as number) || 0,
      retweets: (t.retweet_count as number) || 0,
      replies: (t.reply_count as number) || 0,
      quotes: (t.quote_count as number) || 0,
      author: (t.username || t.user_name || "unknown") as string,
      followers: (t.user_followers_count as number) || 0,
      verified: !!(t.user_verified || t.user_is_blue_verified),
      date: (t.created_at || "") as string,
      hasMedia: Array.isArray(t.media) && (t.media as unknown[]).length > 0,
    })
  ).sort((a: TweetResult, b: TweetResult) => (b.likes + b.retweets) - (a.likes + a.retweets));
}

/**
 * Design and run 5 X/Twitter searches based on brand info.
 */
export async function runXResearch(
  brandKeywords: string,
  competitor: string,
  industry: string,
  icpRole: string
): Promise<string> {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);

  const fmt = (d: Date) => d.toISOString().split("T")[0];

  const runs = [
    {
      label: "Brand/category viral",
      query: `(${brandKeywords}) min_faves:100 since:${fmt(sixMonthsAgo)} -filter:replies -filter:retweets lang:en`,
    },
    {
      label: "Competitor frustration",
      query: `(${competitor}) (sucks OR terrible OR switching OR alternative OR overpriced) min_faves:50 since:${fmt(twelveMonthsAgo)} -filter:retweets`,
    },
    {
      label: "Industry trends",
      query: `(${industry}) (AI OR launching OR "just raised") min_faves:200 since:${fmt(threeMonthsAgo)} filter:media -filter:replies lang:en`,
    },
    {
      label: "Customer pain",
      query: `(${icpRole}) (frustrated OR impossible OR nightmare OR "I hate" OR "fed up") min_faves:25 since:${fmt(twelveMonthsAgo)} -filter:retweets lang:en`,
    },
    {
      label: "Viral launch formats",
      query: `("we raised" OR "introducing" OR "world's first" OR "just launched") min_faves:500 since:${fmt(sixMonthsAgo)} -filter:replies -filter:retweets filter:media lang:en`,
    },
  ];

  const allResults: string[] = [];
  allResults.push("# X/Twitter Research Results\n");

  // Save search designs
  allResults.push("## Search Designs\n");
  runs.forEach((r, i) => {
    allResults.push(`Run ${i + 1} (${r.label}): ${r.query}`);
  });
  allResults.push("\n## Results\n");

  for (const run of runs) {
    try {
      console.log(`[X Research] Starting: ${run.label}`);
      const runId = await startActorRun(run.query, 1000);
      const datasetId = await pollForCompletion(runId);
      const results = await fetchResults(datasetId);
      const top50 = results.slice(0, 50);

      allResults.push(`\n### ${run.label}\n`);
      allResults.push(`Total results: ${results.length}\n`);

      top50.forEach((t, i) => {
        allResults.push(
          `---\nRANK: ${i + 1}\n` +
            `LIKES: ${t.likes} | RT: ${t.retweets} | REPLIES: ${t.replies}\n` +
            `AUTHOR: @${t.author}${t.verified ? " [V]" : ""} (${t.followers.toLocaleString()} followers)\n` +
            `TEXT: ${t.text.replace(/\n/g, " ")}\n`
        );
      });
    } catch (err) {
      console.error(`[X Research] Failed: ${run.label}`, err);
      allResults.push(`\n### ${run.label}\nFAILED: ${err instanceof Error ? err.message : "Unknown error"}\n`);
    }
  }

  return allResults.join("\n");
}
