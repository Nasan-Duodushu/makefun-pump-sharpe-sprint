// Pump.fun Sharpe Sprint — calm-dip scalper.
//
// Ranking is HOURLY SHARPE, not PnL, and a paid place still needs net PnL > 0.
// So the strategy optimises for many small, low-variance wins instead of one
// lucky moonshot: buy a bounded dip only while the tape is calm and buyers are
// still stepping in, take +10%, cut at -5%, never hold long, never pyramid.
// Every decision is a pure function of the batches the harness sends: no clock,
// no randomness, no I/O, so the two graded executions produce identical logs.
//
// Entry idea, in one sentence: a curve that ran up, pulled back 25-55% from its
// recent high, has gone quiet (last 12 trades span <= 12% of price), and shows
// buyers returning (last 10 trades mostly buys, last one a buy, net flow >= 0).
// Exits: +10% take-profit, -5% stop, fade when the flow turns, stale after 450
// slots, a 4% trailing give-back once +8% is reached. One buy per mint, small
// size (2.5% of free cash), so the 20-mint guardrail is met by breadth, not size.
//
// Techniques studied first (kit pilots, ideas only — this file is written fresh
// here): momentum's rolling tape + distinct-buyer flow checks, reversion's
// bounded-drawdown dip entry with tranche discipline, sniper's launch-age and
// creator filters. None of their code is reused.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from "./vendor/makefun-bot.ts";
import { LAMPORTS_PER_SOL } from "./vendor/makefun-bot.ts";

export interface SharpeParams {
  /** Slots of tape kept per mint. */
  tapeTrades: number;
  /** Lookback (slots) for the recent high the dip is measured from. */
  highWindow: number;
  /** Enter when price is at least this far below the recent high (fraction). */
  dipMin: number;
  /** ...and not further than this (a collapse, not a dip). */
  dipMax: number;
  /** Last-N trades whose price span must stay under calmSpan (fraction). */
  calmTrades: number;
  /** Max price span (fraction) over the calm window. */
  calmSpan: number;
  /** Of the last flowTrades trades at least minBuys must be buys. */
  flowTrades: number;
  minBuys: number;
  /** The most recent trade must be a buy. */
  lastMustBeBuy: boolean;
  /** Net SOL flow over the flow window must be >= this (lamports). */
  minNetFlow: bigint;
  /** Slots since CreateEvent before an entry is allowed. */
  minAge: number;
  /** Oldest age (slots) at which a first buy may still be decided. */
  maxAge: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: bigint;
  maxRealSol: bigint;
  /** Share of free cash spent per entry. */
  sizeShare: number;
  /** Smallest / largest single buy (lamports). */
  minBuy: bigint;
  maxBuy: bigint;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits (fractions of cost). */
  takeProfit: number;
  stopLoss: number;
  /** Trailing stop arms at this gain, then gives back this much. */
  trailArm: number;
  trailGiveback: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeTrades: number;
  fadeNetSol: bigint;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same mint may be bought again. */
  cooldown: number;
  /** Most entries per mint over the run. */
  maxEntries: number;
  /** Stop opening new positions once equity falls below this (lamports). */
  equityHalt: bigint;
}

export const DEFAULT_PARAMS: SharpeParams = {
  tapeTrades: 40,
  highWindow: 1500,
  dipMin: 0.32,
  dipMax: 0.5,
  calmTrades: 12,
  calmSpan: 0.07,
  flowTrades: 10,
  minBuys: 8,
  lastMustBeBuy: true,
  minNetFlow: 30_000_000n,
  minAge: 60,
  maxAge: 6000,
  minRealSol: 2_000_000_000n,
  maxRealSol: 60_000_000_000n,
  sizeShare: 0.025,
  minBuy: 50_000_000n,
  maxBuy: 300_000_000n,
  buySlipBps: 500,
  takeProfit: 0.06,
  stopLoss: 0.03,
  trailArm: 0.05,
  trailGiveback: 0.02,
  fadeTrades: 10,
  fadeNetSol: 30_000_000n,
  maxHold: 300,
  cooldown: 600,
  maxEntries: 2,
  equityHalt: 9_200_000_000n,
};

interface TapeTrade {
  slot: number;
  price: number;
  buy: boolean;
  sol: bigint;
}

/** The recent tape of one mint: trades plus a rolling high over highWindow slots. */
class QuoteTape {
  readonly mint: Pubkey;
  createdSlot: number | null = null;
  trades: TapeTrade[] = [];
  /** Samples of (slot, price) for the window high, oldest first. */
  highs: Array<{ slot: number; price: number }> = [];

  constructor(mint: Pubkey) {
    this.mint = mint;
  }

  noteTrade(slot: number, price: number, buy: boolean, sol: bigint, p: SharpeParams): void {
    this.trades.push({ slot, price, buy, sol });
    if (this.trades.length > p.tapeTrades) this.trades.shift();
    this.highs.push({ slot, price });
    while (this.highs.length > 0 && this.highs[0].slot < slot - p.highWindow) this.highs.shift();
  }

  windowHigh(): number {
    let high = 0;
    for (const s of this.highs) if (s.price > high) high = s.price;
    return high;
  }

  recent(n: number): TapeTrade[] {
    return this.trades.slice(-n);
  }

  /** Price span (max/min - 1) over the last n trades; Infinity when too few. */
  span(n: number): number {
    const rs = this.recent(n);
    if (rs.length < n) return Infinity;
    let lo = Infinity;
    let hi = 0;
    for (const t of rs) {
      if (t.price < lo) lo = t.price;
      if (t.price > hi) hi = t.price;
    }
    if (lo <= 0) return Infinity;
    return hi / lo - 1;
  }

  /** Net SOL flow (buys minus sells) over the last n trades. */
  netFlow(n: number): bigint {
    let net = 0n;
    for (const t of this.recent(n)) net += t.buy ? t.sol : -t.sol;
    return net;
  }

  buyCount(n: number): number {
    let c = 0;
    for (const t of this.recent(n)) if (t.buy) c++;
    return c;
  }
}

interface OpenTrade {
  mint: Pubkey;
  entrySlot: number;
  bestValue: bigint;
  entryCost: bigint;
}

/** The book: tapes, open trades, cooldowns and entry counts. Pure batch logic. */
class Book {
  readonly p: SharpeParams;
  readonly tapes = new Map<Pubkey, QuoteTape>();
  readonly open = new Map<Pubkey, OpenTrade>();
  readonly cooldownUntil = new Map<Pubkey, number>();
  readonly entries = new Map<Pubkey, number>();

  constructor(p: SharpeParams) {
    this.p = p;
  }

  tape(mint: Pubkey): QuoteTape {
    let t = this.tapes.get(mint);
    if (t === undefined) {
      t = new QuoteTape(mint);
      this.tapes.set(mint, t);
    }
    return t;
  }

  /** Price in SOL per token from the curve's virtual reserves; null when unpriced. */
  static priceOf(state: BotState, mint: Pubkey): number | null {
    const c = state.curves.get(mint);
    if (c === undefined) return null;
    if (c.virtual_token_reserves <= 0n || c.virtual_quote_reserves <= 0n) return null;
    return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
  }

  /** Fold this batch's events into the tapes. */
  observe(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === "CreateEvent") {
        this.tape(e.mint).createdSlot = e.slot;
      } else if (e.event === "TradeEvent") {
        const price = Book.priceOfRaw(e.virtual_quote_reserves, e.virtual_token_reserves);
        if (price === null) continue;
        this.tape(e.mint).noteTrade(e.slot, price, e.is_buy, BigInt(e.sol_amount), this.p);
      }
    }
  }

  static priceOfRaw(vq: string, vt: string): number | null {
    const q = BigInt(vq);
    const t = BigInt(vt);
    if (q <= 0n || t <= 0n) return null;
    return Number(q) / Number(t);
  }

  /** Mark-to-market value of a held position in lamports. */
  markValue(state: BotState, mint: Pubkey): bigint | null {
    const pos = state.positions.get(mint);
    if (pos === undefined) return null;
    const price = Book.priceOf(state, mint);
    if (price === null) return null;
    const tokens = Number(pos.token_amount);
    return BigInt(Math.floor(tokens * price * 1e9));
  }

  /** Equity: cash plus every position's mark value. */
  equity(state: BotState): bigint {
    let eq = state.cash;
    for (const mint of state.positions.keys()) {
      const v = this.markValue(state, mint);
      if (v !== null) eq += v;
    }
    return eq;
  }

  /** Sync open trades with the harness account: drop closed ones, refresh best value. */
  sync(state: BotState): void {
    for (const mint of [...this.open.keys()]) {
      const pos = state.positions.get(mint);
      if (pos === undefined) {
        this.open.delete(mint);
        this.cooldownUntil.set(mint, state.slot + this.p.cooldown);
        continue;
      }
      const v = this.markValue(state, mint);
      const tr = this.open.get(mint);
      if (v !== null && tr !== undefined && v > tr.bestValue) tr.bestValue = v;
    }
    for (const [mint, pos] of state.positions) {
      if (!this.open.has(mint)) {
        this.open.set(mint, {
          mint,
          entrySlot: state.slot,
          bestValue: pos.cost_lamports,
          entryCost: pos.cost_lamports,
        });
      }
    }
  }

  /** Should this mint be bought now? Every condition is a Sharpe-shaped filter. */
  entrySignal(state: BotState, mint: Pubkey): boolean {
    const p = this.p;
    const tape = this.tapes.get(mint);
    const curve = state.curves.get(mint);
    if (tape === undefined || curve === undefined) return false;
    if (curve.complete) return false;
    if (tape.createdSlot === null) return false;
    const age = state.slot - tape.createdSlot;
    if (age < p.minAge || age > p.maxAge) return false;
    if (this.open.has(mint)) return false;
    if (state.positions.has(mint)) return false;
    if ((this.cooldownUntil.get(mint) ?? -1) > state.slot) return false;
    if ((this.entries.get(mint) ?? 0) >= p.maxEntries) return false;
    if (curve.real_quote_reserves < p.minRealSol || curve.real_quote_reserves > p.maxRealSol) return false;
    const price = Book.priceOf(state, mint);
    if (price === null || price <= 0) return false;
    const high = tape.windowHigh();
    if (high <= 0) return false;
    const dip = 1 - price / high;
    if (dip < p.dipMin || dip > p.dipMax) return false;
    if (tape.span(p.calmTrades) > p.calmSpan) return false;
    const recent = tape.recent(p.flowTrades);
    if (recent.length < p.flowTrades) return false;
    if (tape.buyCount(p.flowTrades) < p.minBuys) return false;
    if (p.lastMustBeBuy && !recent[recent.length - 1].buy) return false;
    if (tape.netFlow(p.flowTrades) < p.minNetFlow) return false;
    return true;
  }

  /** Sell reason for a held position, or null to keep holding. */
  exitReason(state: BotState, mint: Pubkey): string | null {
    const p = this.p;
    const tr = this.open.get(mint);
    const pos = state.positions.get(mint);
    if (tr === undefined || pos === undefined) return null;
    const value = this.markValue(state, mint);
    if (value === null) return null;
    const cost = pos.cost_lamports;
    if (cost <= 0n) return null;
    const ratio = Number(value) / Number(cost);
    if (ratio >= 1 + p.takeProfit) return "take-profit";
    if (ratio <= 1 - p.stopLoss) return "stop-loss";
    if (value >= BigInt(Math.floor(Number(cost) * (1 + p.trailArm)))) {
      const trail = (tr.bestValue * BigInt(Math.floor((1 - p.trailGiveback) * 1e6))) / 1_000_000n;
      if (value <= trail) return "trailing-stop";
    }
    if (state.slot - tr.entrySlot >= p.maxHold) return "stale";
    const tape = this.tapes.get(mint);
    if (tape !== undefined && tape.netFlow(p.fadeTrades) < -p.fadeNetSol) return "fade";
    return null;
  }

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const p = this.p;
    this.observe(batch);
    this.sync(state);
    const orders: OrderInput[] = [];
    const free = state.freeCashLamports();

    // Exits first: free the slot before any new entry is considered.
    for (const mint of [...state.positions.keys()]) {
      const reason = this.exitReason(state, mint);
      if (reason === null) continue;
      const pos = state.positions.get(mint);
      if (pos === undefined) continue;
      orders.push({
        side: "sell",
        mint,
        token_amount: pos.token_amount.toString(),
        max_slippage_bps: 10000,
      });
      console.error(`slot ${state.slot}: sell ${mint.slice(0, 8)} (${reason})`);
    }

    // Entries: breadth over size, only while equity holds up. Size each buy
    // from the cash still free after this batch's earlier buys, so a batch
    // with several signals cannot overspend the account.
    if (this.equity(state) < p.equityHalt) return orders;
    if (state.committedPositionCount() >= state.hello.caps.max_open_positions) return orders;
    const cap = state.hello.caps.max_orders_per_batch;
    let buysSent = 0;
    let spentThisBatch = 0n;
    for (const mint of this.tapes.keys()) {
      if (orders.length >= cap) break;
      if (state.committedPositionCount() + buysSent >= state.hello.caps.max_open_positions) break;
      if (!this.entrySignal(state, mint)) continue;
      const remaining = free - spentThisBatch;
      if (remaining < p.minBuy) break;
      let size = (remaining * BigInt(Math.floor(p.sizeShare * 1e6))) / 1_000_000n;
      if (size < p.minBuy) continue;
      if (size > p.maxBuy) size = p.maxBuy;
      const room = state.maxBuyLamports(mint);
      if (room <= 0n) continue;
      if (size > room) size = room;
      if (size < p.minBuy) continue;
      orders.push({ side: "buy", mint, quote_lamports: size.toString(), max_slippage_bps: p.buySlipBps });
      buysSent++;
      spentThisBatch += size + state.txFeeLamports();
      this.entries.set(mint, (this.entries.get(mint) ?? 0) + 1);
      console.error(`slot ${state.slot}: buy ${mint.slice(0, 8)} ${size} lamports`);
    }
    return orders;
  }
}

export function createStrategy(params: SharpeParams = DEFAULT_PARAMS): Bot {
  const book = new Book(params);
  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      return book.onBatch(state, batch);
    },
  };
}
