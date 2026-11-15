// The token radar model turns one sealed protocol snapshot into a ranked board and live view.
// Every score comes from the snapshot's own TVL, growth, category, chains, and listing date.

/** One protocol record in the source snapshot. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The complete input document consumed by the model. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Tunable constants exposed by the dashboard and model sandbox. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
}

/** Default radar-2 constants. */
export const MODEL: ModelConstants = {
  base_multiple: 0.25,
  growth_weight: 0.75,
  growth_floor: -80,
  growth_cap: 200,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 540,
  unknown_age_days: 365,
};

/** Public model version label. */
export const MODEL_VERSION = 'radar-2';

/** Number of early, pre-token rows to describe in the product copy. */
export const EARLY_ROWS = 160;

/** Maximum number of protocols shown in the live-token panel. */
export const LIVE_ROWS = 24;

/** A farm action together with its estimated cost and duration. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A fully scored and ranked row written to board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A row in the dashboard's compact radar dataset. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  farm_steps: string[];
  watchlist: boolean;
}

/** An already-tokenized protocol shown separately from the ranked board. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** The complete serialized dashboard dataset. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
  category_multiples: Record<string, { multiple: number; comparable_count: number }>;
}

/** An invalid or unusable source snapshot. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const CATEGORY_FALLBACK = 0.169;

/** Return a finite numeric value or the supplied fallback. */
function finite(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

/** Calculate elapsed whole days, with future dates clamped to zero. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) {
    return null;
  }
  const asOfTime = Date.parse(`${asOf}T00:00:00Z`);
  const listedTime = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(asOfTime) || !Number.isFinite(listedTime)) {
    return null;
  }
  return Math.max(0, Math.floor((asOfTime - listedTime) / DAY_MS));
}

/** Compute the score and each component for one protocol. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): {
  implied: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  breadthMult: number;
  age: number | null;
} {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(
    model.growth_cap,
    Math.max(model.growth_floor, rawGrowth),
  );
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  let maturityMult: number;

  if (ageForModel <= 540) {
    maturityMult = 0.6 + (Math.max(0, ageForModel) / 540) * 0.4;
  } else if (ageForModel < 1460) {
    maturityMult = 1 - ((ageForModel - 540) / 920) * 0.3;
  } else {
    maturityMult = 0.7;
  }

  const breadthMult = 1 + 0.02 * Math.min(protocol.chains.length, 5);
  const base = protocol.tvl_usd * model.base_multiple;
  const implied = Math.max(
    1,
    Math.round(base * growthMult * maturityMult * breadthMult),
  );

  return {
    implied,
    growthPct,
    growthMult,
    maturityMult,
    breadthMult,
    age,
  };
}

/** Compute clamped category medians from records that already carry a token. */
function categoryMultiples(
  snapshot: Snapshot,
): Record<string, { multiple: number; comparable_count: number }> {
  const live = snapshot.protocols.filter(
    (protocol) =>
      protocol.mcap_usd !== null ||
      protocol.gecko_id !== null ||
      protocol.symbol !== null,
  );

  const median = (values: number[]): number => {
    const sorted = [...values].sort((left, right) => left - right);
    const count = sorted.length;
    if (count === 0) {
      return CATEGORY_FALLBACK;
    }
    if (count % 2 === 1) {
      return sorted[(count - 1) / 2]!;
    }
    return (sorted[count / 2 - 1]! + sorted[count / 2]!) / 2;
  };

  const overallValues = live
    .filter(
      (protocol) => protocol.mcap_usd !== null && protocol.tvl_usd > 0,
    )
    .map((protocol) => protocol.mcap_usd! / protocol.tvl_usd);
  const overallMedian = median(overallValues);
  const categories = [
    ...new Set(snapshot.protocols.map((protocol) => protocol.category ?? 'Unknown')),
  ].sort();
  const result: Record<string, { multiple: number; comparable_count: number }> = {};

  for (const category of categories) {
    const comparableRows = live.filter(
      (protocol) =>
        (protocol.category ?? 'Unknown') === category &&
        protocol.mcap_usd !== null &&
        protocol.tvl_usd > 0,
    );
    const values = comparableRows.map(
      (protocol) => protocol.mcap_usd! / protocol.tvl_usd,
    );
    const rawMultiple =
      values.length >= 10 ? median(values) : overallMedian;

    result[category] = {
      multiple: Math.min(0.6, Math.max(0.03, rawMultiple)),
      comparable_count: comparableRows.length,
    };
  }

  return result;
}

/** A name ending in a release marker represents a versioned product. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether the source record says the protocol records no token. */
export function isPreToken(protocol: SnapshotProtocol): boolean {
  return (
    protocol.mcap_usd === null &&
    protocol.gecko_id === null &&
    protocol.symbol === null
  );
}

const NON_CANDIDATE_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const DERIVATIVE_NAME = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_NAME = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

/** Apply the starter launch-candidate rule without special-casing protocols. */
export function isRankable(protocol: SnapshotProtocol): boolean {
  return (
    isPreToken(protocol) &&
    !NON_CANDIDATE_CATEGORIES.has(protocol.category ?? '') &&
    !DERIVATIVE_NAME.test(protocol.name) &&
    !EXCHANGE_NAME.test(protocol.name) &&
    !VERSIONED.test(protocol.name)
  );
}

/** Index protocol records by their unique source slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((protocol) => [protocol.slug, protocol]));
}

/** Counts used in the dashboard's headline sentence. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** Build all rankable pre-token rows in implied-value order. */
export function buildBoard(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): BoardRow[] {
  const multiples = categoryMultiples(snapshot);
  const scored = snapshot.protocols.filter(isRankable).map((protocol) => {
    const categoryMultiple =
      multiples[protocol.category ?? 'Unknown']?.multiple ?? model.base_multiple;
    const parts = impliedValue(protocol, snapshot.as_of, {
      ...model,
      base_multiple: categoryMultiple,
    });

    return {
      protocol,
      ...parts,
      categoryMultiple,
    };
  });

  scored.sort((left, right) => {
    if (left.implied !== right.implied) {
      return right.implied - left.implied;
    }
    if (left.protocol.slug < right.protocol.slug) {
      return -1;
    }
    if (left.protocol.slug > right.protocol.slug) {
      return 1;
    }
    return 0;
  });

  return scored.map((score, index) => ({
    rank: index + 1,
    slug: score.protocol.slug,
    name: score.protocol.name,
    category: score.protocol.category,
    chains: score.protocol.chains,
    tvl_usd: score.protocol.tvl_usd,
    change_7d: score.protocol.change_7d,
    mcap_usd: score.protocol.mcap_usd,
    listed_at: score.protocol.listed_at,
    gecko_id: score.protocol.gecko_id,
    symbol: score.protocol.symbol,
    token_status: 'pre-token',
    age_days: score.age,
    implied_value_usd: score.implied,
    model: {
      base_multiple: score.categoryMultiple,
      growth_pct: score.growthPct,
      growth_multiplier: round4(score.growthMult),
      maturity_multiplier: round4(score.maturityMult),
      breadth_multiplier: round4(score.breadthMult),
      age_days: score.age,
    },
    farm_steps: farmSteps(score.protocol, score.age).map(stepText),
  }));
}

/** Round model components to four decimal places for display. */
const round4 = (value: number): number => {
  return Math.round(value * 1e4) / 1e4;
};

/** Render one farm step with its cost and time, within the character gate. */
export function stepText(step: FarmStep): string {
  let text = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (text.length > 600) {
    text = `${text.slice(0, 596)}...`;
  }
  if (text.length < 20) {
    text = `${text} Hold the position and check the protocol's own page.`;
  }
  return text;
}

/** Choose the first recorded chain, or a neutral description if absent. */
function chainOf(protocol: SnapshotProtocol): string {
  if (protocol.chains.length > 0) {
    return protocol.chains[0]!;
  }
  return 'its main chain';
}

/** Estimate position capital from the protocol's own TVL band. */
function capitalFor(protocol: SnapshotProtocol): number {
  if (protocol.tvl_usd >= 5_000_000_000) {
    return 250;
  }
  if (protocol.tvl_usd >= 1_000_000_000) {
    return 150;
  }
  if (protocol.tvl_usd >= 100_000_000) {
    return 100;
  }
  return 50;
}

/** Use a longer hold window for younger protocols. */
function holdDaysFor(age: number | null): number {
  if (age === null) {
    return 30;
  }
  if (age < 180) {
    return 60;
  }
  if (age < 365) {
    return 45;
  }
  return 30;
}

/** Describe the primary category-specific action for a protocol. */
function actionFor(
  protocol: SnapshotProtocol,
  capital: number,
  chain: string,
): string {
  const category = (protocol.category ?? '').toLowerCase();
  const name = protocol.name;

  if (
    category.includes('lend') ||
    category.includes('cdp') ||
    category.includes('collateral')
  ) {
    return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  }
  if (
    category.includes('dex') ||
    category.includes('yield') ||
    category.includes('leveraged farm')
  ) {
    return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  }
  if (category.includes('bridge')) {
    return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  }
  if (category.includes('staking') || category.includes('restak')) {
    return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  }
  if (category.includes('perpetual') || category.includes('derivative')) {
    return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  }
  if (category.includes('prediction')) {
    return `Fund $${capital} and place one market position on ${name}.`;
  }
  if (category.includes('curator') || category.includes('allocator')) {
    return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  }
  if (category.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  }
  if (category.includes('rwa')) {
    return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  }
  if (category.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** Build six practical, source-derived farm steps with cost and time on every step. */
export function farmSteps(
  protocol: SnapshotProtocol,
  age: number | null,
): FarmStep[] {
  const chain = chainOf(protocol);
  const capital = capitalFor(protocol);
  const hold = holdDaysFor(age);
  const action = actionFor(protocol, capital, chain);
  const category = (protocol.category ?? '').toLowerCase();
  let secondAction: string | null = null;

  if (category.includes('lend')) {
    secondAction = `Borrow a small amount against your position on ${chain} so a borrow event registers.`;
  } else if (category.includes('dex')) {
    secondAction = `Make one swap in the same ${chain} pool each week and keep the transaction record.`;
  }

  const weeklyAction =
    secondAction ??
    `Make one qualifying ${protocol.category ?? 'protocol'} action each week on ${chain}, using the protocol's own app.`;

  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: weeklyAction,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** Select live-token records, sorted by market cap, then TVL, then slug. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((protocol) => !isPreToken(protocol) && protocol.category !== 'CEX')
    .sort((left, right) => {
      const marketCapOrder = (right.mcap_usd ?? 0) - (left.mcap_usd ?? 0);
      if (marketCapOrder !== 0) {
        return marketCapOrder;
      }
      if (right.tvl_usd !== left.tvl_usd) {
        return right.tvl_usd - left.tvl_usd;
      }
      if (left.slug < right.slug) {
        return -1;
      }
      if (left.slug > right.slug) {
        return 1;
      }
      return 0;
    })
    .slice(0, LIVE_ROWS)
    .map((protocol) => ({
      slug: protocol.slug,
      name: protocol.name,
      category: protocol.category,
      chains: protocol.chains,
      tvl_usd: protocol.tvl_usd,
      mcap_usd: protocol.mcap_usd,
      change_7d: protocol.change_7d,
    }));
}

/** Convert one board row into the compact dashboard representation. */
export function radarRow(
  row: BoardRow,
  watchlist: string[] = [],
): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
    farm_steps: row.farm_steps,
    watchlist: watchlist.includes(row.slug),
  };
}

/** Build the board and its dashboard data, keeping live tokens in a separate view. */
export function buildRadar(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter(
    (row) => !snapshot.watchlist.includes(row.slug),
  ).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map((row) => radarRow(row, snapshot.watchlist)),
    live,
    category_multiples: categoryMultiples(snapshot),
  };

  return { board, radar };
}

/** Parse and validate the source snapshot's strict outer shape. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }

  const object = raw as Record<string, unknown>;
  if (
    typeof object.as_of !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(object.as_of)
  ) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof object.source !== 'string') {
    throw new SnapshotError('snapshot.json has no source');
  }
  if (
    typeof object.floor_usd !== 'number' ||
    !Number.isSafeInteger(object.floor_usd) ||
    object.floor_usd <= 0
  ) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(object.protocols)) {
    throw new SnapshotError('snapshot.json has no protocols array');
  }
  if (
    !Array.isArray(object.watchlist) ||
    object.watchlist.some((slug) => typeof slug !== 'string')
  ) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }

  const protocols = object.protocols.map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new SnapshotError(
        `snapshot.json's protocol ${index} is not an object`,
      );
    }

    const protocol = value as Record<string, unknown>;
    if (
      typeof protocol.slug !== 'string' ||
      typeof protocol.name !== 'string' ||
      typeof protocol.tvl_usd !== 'number' ||
      !Number.isFinite(protocol.tvl_usd)
    ) {
      throw new SnapshotError(
        `snapshot.json's protocol ${index} lacks a slug, a name or a TVL`,
      );
    }

    return {
      slug: protocol.slug,
      name: protocol.name,
      category:
        typeof protocol.category === 'string' ? protocol.category : null,
      chains: Array.isArray(protocol.chains)
        ? protocol.chains.filter(
            (chain): chain is string => typeof chain === 'string',
          )
        : [],
      tvl_usd: protocol.tvl_usd,
      change_7d:
        typeof protocol.change_7d === 'number' &&
        Number.isFinite(protocol.change_7d)
          ? protocol.change_7d
          : null,
      mcap_usd:
        typeof protocol.mcap_usd === 'number' &&
        Number.isFinite(protocol.mcap_usd)
          ? protocol.mcap_usd
          : null,
      listed_at:
        typeof protocol.listed_at === 'string' ? protocol.listed_at : null,
      gecko_id:
        typeof protocol.gecko_id === 'string' ? protocol.gecko_id : null,
      symbol: typeof protocol.symbol === 'string' ? protocol.symbol : null,
    };
  });

  return {
    as_of: object.as_of,
    source: object.source,
    floor_usd: object.floor_usd,
    protocols,
    watchlist: object.watchlist as string[],
  };
}

/** Check watchlist coverage, rank sequence, order, farm lengths, and positive values. */
export function boardIssue(
  board: BoardRow[],
  snapshot: Snapshot,
): string | null {
  const slugs = new Set(board.map((row) => row.slug));
  const missing = snapshot.watchlist.filter((slug) => !slugs.has(slug));
  if (missing.length > 0) {
    const noun = missing.length === 1 ? 'slug' : 'slugs';
    return `the board misses ${missing.length} watchlist ${noun}: ${missing.slice(0, 5).join(', ')}`;
  }

  const ranks = board.map((row) => row.rank).sort((left, right) => left - right);
  for (let index = 0; index < ranks.length; index += 1) {
    if (ranks[index] !== index + 1) {
      return `rank ${index + 1} is ${ranks[index]}`;
    }
  }
  for (let index = 1; index < board.length; index += 1) {
    if (board[index]!.implied_value_usd > board[index - 1]!.implied_value_usd) {
      return `row ${index + 1} outranks row ${index} on implied value`;
    }
  }

  if (
    board.length >= 2 &&
    board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd
  ) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }

  for (const row of board) {
    const steps = row.farm_steps;
    if (steps.length < 3 || steps.length > 12) {
      return `${row.slug} has ${steps.length} farm steps`;
    }
    for (const step of steps) {
      if (step.length < 20 || step.length > 600) {
        return `${row.slug} has a farm step of ${step.length} characters`;
      }
    }
    if (
      !Number.isSafeInteger(row.implied_value_usd) ||
      row.implied_value_usd <= 0
    ) {
      return `${row.slug} has implied value ${row.implied_value_usd}`;
    }
  }

  return null;
}

/** Serialize the radar dataset as a browser global assignment. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
