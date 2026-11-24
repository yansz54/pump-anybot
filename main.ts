// Pump.fun Paper Sprint: Any Bot Can Win
// ---------------------------------------------------------------
// Strategy: a "launch sniper" with a rug filter, plus a pace-based
// guardrail filler.
//
// 1. MAIN LEG — buy fresh bonding-curve mints in their first few
//    slots, but only when exactly two distinct non-creator wallets
//    have bought and the creator's own buy is small (<= 2 SOL).
//    That filter selects coins with genuine early distribution
//    instead of a single creator wash-buying his own launch.
//    Buys are capped by the harness 1%-of-real-reserve rule and
//    floored at 0.01 SOL so every round trip counts toward the
//    20-mint guardrail. Exits: take profit +25%, cut at -12%,
//    or exit after 5 slots; also exit the moment the creator
//    sells. One buy per coin, no pyramiding, no order splitting
//    (splitting only burns extra tx fees).
//
// 2. FILLER LEG — the main leg trades ~25 coins per 6h, but coin
//    flow is bursty and a quiet 6h can drop below the 20-mint
//    guardrail. The filler tracks elapsed block time and the
//    number of counted mints; whenever we fall behind the pace
//    needed for 22 mints in 6h, it buys exactly 0.01 SOL of the
//    hottest liquid coin in the current batch and sells it on the
//    next batch. A filler round trip costs ~0.0005 SOL in fees,
//    so it only fires when the guardrail actually needs it.
//
// The bot is fully deterministic: no clock, no randomness, no
// Date.now, no Math.random. Iteration order is insertion order
// of Maps, and all money math is exact bigint arithmetic.

export interface Order {
  side: 'buy' | 'sell';
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

export interface Hello {
  type: 'hello';
  protocol?: string;
  seed?: string;
  capital: { lamports: string };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
    shorts: boolean;
    leverage: boolean;
  };
  latency_slots: number;
  fees?: {
    protocol_bps_fallback?: number;
    creator_bps_fallback?: number;
    base_fee_lamports?: string;
    priority_fee_lamports?: string;
    failed_tx_bps?: number;
  };
  universe?: { sample?: { modulus?: number; residue?: number } };
}

export interface TradeEvent {
  event: 'TradeEvent';
  slot: number;
  block_time: number | null;
  timestamp?: string;
  mint: string;
  user: string;
  is_buy: boolean;
  sol_amount: string;
  virtual_token_reserves: string;
  virtual_quote_reserves: string;
  real_token_reserves: string;
  real_quote_reserves: string;
}

export interface CreateEvent {
  event: 'CreateEvent';
  slot: number;
  block_time: number | null;
  timestamp?: string;
  mint: string;
  creator: string;
  virtual_token_reserves: string;
  virtual_quote_reserves: string;
  // Create events carry no real reserves (nothing has traded yet).
  real_token_reserves?: string;
  real_quote_reserves?: string;
}

export interface CompleteEvent {
  event: 'CompleteEvent';
  slot: number;
  block_time: number | null;
  timestamp?: string;
  mint: string;
}

export type ChainEvent = TradeEvent | CreateEvent | CompleteEvent;

export interface Mark {
  mint: string;
  slot: number;
  virtual_token_reserves: string;
  virtual_quote_reserves: string;
  real_token_reserves: string;
  real_quote_reserves: string;
}

export interface Fill {
  client_id: string;
  mint: string;
  status: 'filled' | 'rejected' | 'failed';
  side?: 'buy' | 'sell';
  quote_lamports?: string;
  token_amount?: string;
  tx_fee_lamports?: string;
  slot?: number;
  reason?: string;
}

export interface Batch {
  type: 'batch';
  seq: number;
  slot: number;
  events: ChainEvent[];
  marks: Mark[];
  fills: Fill[];
  account: { cash_lamports: string; positions?: { mint: string; token_amount: string; cost_lamports: string }[] };
}

export interface DoneMsg {
  type: 'done';
  seq: number;
  reason?: string;
  account?: Batch['account'];
}

export interface Reply {
  type: 'reply';
  seq: number;
  orders: Order[];
}

// --- protocol constants (from the harness hello; fall back to spec) ---
const BPS = 10000n;

function bpsOf(v: bigint, bps: bigint): bigint {
  return (v * bps) / BPS;
}

// Value of a token holding at a curve, net of one tx fee.
function sellValueLamports(tokens: bigint, vt: bigint, vq: bigint, feeBps: bigint, txFee: bigint): bigint {
  if (tokens <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  const fee = bpsOf(q, feeBps);
  const net = q - fee - txFee;
  return net > 0n ? net : 0n;
}

export interface Curve {
  mint: string;
  created_slot: number;
  virtual_token_reserves: bigint;
  virtual_quote_reserves: bigint;
  real_token_reserves: bigint;
  real_quote_reserves: bigint;
  reserves_slot: number;
  trades: number;
  complete: boolean;
}

export interface Holding {
  token_amount: bigint;
  cost_lamports: bigint;
}

export interface PendingOrder {
  client_id: string;
  order: Order;
  seq: number;
  decided_slot: number;
}

// The bot's view of the world: maintained from hello/batch messages,
// and exposed to the strategy as a plain object with no hidden state.
export class BotView {
  capital = 0n;
  cash = 0n;
  maxPositions = 5;
  maxOrderBps = 100;
  maxOrdersPerBatch = 16;
  latencySlots = 2;
  feeBps = 125n; // protocol 95 + creator 30
  txFee = 105000n; // base 5000 + priority 100000
  failedTxBps = 200n;
  curves = new Map<string, Curve>();
  positions = new Map<string, Holding>();
  pending = new Map<string, PendingOrder>();
  seq = 0;
  slot = 0;
  seqCounter = 0;

  applyHello(h: Hello): void {
    this.capital = BigInt(h.capital.lamports);
    this.cash = this.capital;
    this.maxPositions = h.caps.max_open_positions;
    this.maxOrderBps = h.caps.max_order_bps_of_real_reserve;
    this.maxOrdersPerBatch = h.caps.max_orders_per_batch;
    this.latencySlots = h.latency_slots;
    if (h.fees !== undefined) {
      this.feeBps = BigInt(h.fees.protocol_bps_fallback ?? 95) + BigInt(h.fees.creator_bps_fallback ?? 30);
      this.txFee = BigInt(h.fees.base_fee_lamports ?? '5000') + BigInt(h.fees.priority_fee_lamports ?? '100000');
      this.failedTxBps = BigInt(h.fees.failed_tx_bps ?? 200);
    }
  }

  // Largest quote (in lamports) a buy on this mint may spend right now.
  maxBuyLamports(mint: string): bigint {
    const c = this.curves.get(mint);
    if (c === undefined) return 0n;
    return (c.real_quote_reserves * BigInt(this.maxOrderBps)) / BPS;
  }

  freeCashLamports(): bigint {
    let reserved = 0n;
    for (const p of this.pending.values()) {
      if (p.order.side === 'buy') reserved += BigInt(p.order.quote_lamports ?? '0');
    }
    const free = this.cash - reserved;
    return free > 0n ? free : 0n;
  }

  txFeeLamports(): bigint {
    return this.txFee;
  }

  committedPositionCount(): number {
    const held = new Set<string>();
    for (const m of this.positions.keys()) held.add(m);
    for (const p of this.pending.values()) held.add(p.order.mint);
    return held.size;
  }

  clientId(prefix: string): string {
    this.seqCounter += 1;
    return `${prefix}${this.seqCounter}`;
  }

  // Apply the events of one batch to the curve table.
  applyEvents(events: ChainEvent[]): void {
    for (const e of events) {
      if (e.event === 'CreateEvent') {
        if (this.curves.has(e.mint)) continue;
        this.curves.set(e.mint, {
          mint: e.mint,
          created_slot: e.slot,
          virtual_token_reserves: BigInt(e.virtual_token_reserves),
          virtual_quote_reserves: BigInt(e.virtual_quote_reserves),
          real_token_reserves: BigInt(e.real_token_reserves ?? '0'),
          real_quote_reserves: BigInt(e.real_quote_reserves ?? '0'),
          reserves_slot: e.slot,
          trades: 0,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        let c = this.curves.get(e.mint);
        if (c === undefined) {
          c = {
            mint: e.mint,
            created_slot: e.slot,
            virtual_token_reserves: BigInt(e.virtual_token_reserves),
            virtual_quote_reserves: BigInt(e.virtual_quote_reserves),
            real_token_reserves: BigInt(e.real_token_reserves),
            real_quote_reserves: BigInt(e.real_quote_reserves),
            reserves_slot: e.slot,
            trades: 0,
            complete: false,
          };
          this.curves.set(e.mint, c);
        }
        c.virtual_token_reserves = BigInt(e.virtual_token_reserves);
        c.virtual_quote_reserves = BigInt(e.virtual_quote_reserves);
        c.real_token_reserves = BigInt(e.real_token_reserves);
        c.real_quote_reserves = BigInt(e.real_quote_reserves);
        c.reserves_slot = e.slot;
        c.trades += 1;
      } else if (e.event === 'CompleteEvent') {
        const c = this.curves.get(e.mint);
        if (c !== undefined) c.complete = true;
      }
    }
  }

  applyMarks(marks: Mark[]): void {
    for (const m of marks) {
      const c = this.curves.get(m.mint);
      if (c === undefined) continue;
      if (m.slot < c.reserves_slot) continue; // stale mark: never regress reserves
      c.virtual_token_reserves = BigInt(m.virtual_token_reserves);
      c.virtual_quote_reserves = BigInt(m.virtual_quote_reserves);
      c.real_token_reserves = BigInt(m.real_token_reserves);
      c.real_quote_reserves = BigInt(m.real_quote_reserves);
      c.reserves_slot = m.slot;
    }
  }

  applyAccount(a: Batch['account']): void {
    this.cash = BigInt(a.cash_lamports);
    if (a.positions !== undefined) {
      this.positions.clear();
      for (const p of a.positions) {
        this.positions.set(p.mint, { token_amount: BigInt(p.token_amount), cost_lamports: BigInt(p.cost_lamports) });
      }
    }
  }

  // Reconcile pending orders against this batch's fills.
  applyFills(fills: Fill[]): void {
    for (const f of fills) {
      this.pending.delete(f.client_id);
      if (f.client_id.startsWith('_')) continue;
      if (f.status === 'filled' && f.side === 'buy') {
        const paid = BigInt(f.quote_lamports ?? '0');
        const tokens = BigInt(f.token_amount ?? '0');
        const prev = this.positions.get(f.mint);
        if (prev === undefined) this.positions.set(f.mint, { token_amount: tokens, cost_lamports: paid });
        else {
          prev.token_amount += tokens;
          prev.cost_lamports += paid;
        }
      } else if (f.status === 'filled' && f.side === 'sell') {
        const tokens = BigInt(f.token_amount ?? '0');
        const prev = this.positions.get(f.mint);
        if (prev !== undefined) {
          prev.token_amount -= tokens;
          if (prev.token_amount <= 0n) this.positions.delete(f.mint);
        }
      }
    }
  }
}

// ------------------------------------------------------------------
// Strategy
// ------------------------------------------------------------------

// The minimal surface the strategy needs from the bot's state. The
// live wire loop passes a BotView; the local backtest passes a thin
// wrapper around the kit's reference BotState. Both are the same
// shape, so the strategy behaves identically in both.
export interface BotLike {
  curves: Map<string, Curve>;
  positions: Map<string, Holding>;
  pending: Map<string, PendingOrder>;
  maxOrdersPerBatch: number;
  maxPositions: number;
  feeBps: bigint;
  txFee: bigint;
  slot: number;
  maxBuyLamports(mint: string): bigint;
  freeCashLamports(): bigint;
  txFeeLamports(): bigint;
  committedPositionCount(): number;
  clientId(prefix: string): string;
}

// Block time of an event, falling back to its timestamp string.
function eventTime(e: ChainEvent): number {
  if (typeof e.block_time === 'number' && e.block_time > 0) return e.block_time;
  if (typeof e.timestamp === 'string') {
    const t = Number(e.timestamp);
    if (Number.isFinite(t) && t > 0) return t;
  }
  return 0;
}

export interface StrategyParams {
  // Main leg (launch sniper)
  stakeLamports: bigint;
  minBuyLamports: bigint;
  minAge: number;
  maxAge: number;
  minRealSol: bigint;
  maxRealSol: bigint;
  minDevBuy: bigint;
  maxDevBuy: bigint;
  minBuyers: number;
  maxBuyers: number;
  skipDevSold: boolean;
  buySlippageBps: number;
  tpBps: bigint;
  slBps: bigint;
  maxHold: number;
  exitOnDevSell: boolean;
  // Filler leg (guardrail pace)
  fillerBuyLamports: bigint;
  fillerTargetMints: number;
  fillerWindowSecs: number;
  fillerMinRealSol: bigint;
}

export const DEFAULT_PARAMS: StrategyParams = {
  stakeLamports: 100_000_000n, // 0.10 SOL
  minBuyLamports: 10_000_000n, // 0.01 SOL — every counted round trip is >= this
  minAge: 0,
  maxAge: 10,
  minRealSol: 300_000_000n, // 0.3 SOL
  maxRealSol: 30_000_000_000n, // 30 SOL
  minDevBuy: 0n,
  maxDevBuy: 2_000_000_000n, // 2 SOL
  minBuyers: 2,
  maxBuyers: 2,
  skipDevSold: true,
  buySlippageBps: 10000,
  tpBps: 2500n, // +25%
  slBps: 1200n, // -12%
  maxHold: 5,
  exitOnDevSell: true,
  fillerBuyLamports: 10_000_000n, // 0.01 SOL
  fillerTargetMints: 22,
  fillerWindowSecs: 21600, // 6 hours
  fillerMinRealSol: 1_500_000_000n, // 1.5 SOL
};

interface CoinTrack {
  mint: string;
  creator: string;
  createSlot: number;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  trades: number;
  buyers: Set<string>;
  bought: bigint;
  soldByOthers: bigint;
  lastTradeSlot: number;
  buysSent: number;
  spentSent: bigint;
  lastBuySlot: number;
  done: boolean;
  complete: boolean;
}

interface HeldTrack {
  openedSlot: number;
  txPaid: bigint;
  devSoldAtOpen: boolean;
  filler: boolean;
}

export function createStrategy(params: StrategyParams = DEFAULT_PARAMS) {
  const coins = new Map<string, CoinTrack>();
  const held = new Map<string, HeldTrack>();
  const selling = new Set<string>();
  let firstBlockTime = 0;
  let lastBlockTime = 0;
  const countedMints = new Set<string>(); // mints with a filled buy >= minBuy
  const stats = { fillerBuys: 0, fillerTrips: 0, mainBuys: 0 };
  const fillerSeen = new Set<string>(); // mints the filler already bought (never re-buy: own flow skews the cap)
  let fillerInFlight: string | null = null;

  const getCoin = (mint: string): CoinTrack | undefined => coins.get(mint);

  function trackEvent(e: ChainEvent): void {
    if (e.event === 'CreateEvent') {
      if (coins.has(e.mint)) return;
      coins.set(e.mint, {
        mint: e.mint,
        creator: e.creator,
        createSlot: e.slot,
        vq0: BigInt(e.virtual_quote_reserves),
        vt0: BigInt(e.virtual_token_reserves),
        devBuy: 0n,
        devSold: false,
        trades: 0,
        buyers: new Set(),
        bought: 0n,
        soldByOthers: 0n,
        lastTradeSlot: 0,
        buysSent: 0,
        spentSent: 0n,
        lastBuySlot: -1,
        done: false,
        complete: false,
      });
      return;
    }
    if (e.event === 'TradeEvent') {
      let c = coins.get(e.mint);
      if (c === undefined) {
        c = {
          mint: e.mint,
          creator: '',
          createSlot: e.slot,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          devSold: false,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          lastTradeSlot: 0,
          buysSent: 0,
          spentSent: 0n,
          lastBuySlot: -1,
          done: false,
          complete: false,
        };
        coins.set(e.mint, c);
      }
      const sol = BigInt(e.sol_amount);
      c.trades += 1;
      c.lastTradeSlot = e.slot;
      if (e.slot === c.createSlot && e.user === c.creator) {
        if (e.is_buy) c.devBuy += sol;
        else c.devSold = true;
      } else if (!e.is_buy && e.user === c.creator) {
        c.devSold = true;
      } else if (e.is_buy && e.user !== c.creator) {
        c.buyers.add(e.user);
        c.bought += sol;
      } else if (!e.is_buy && e.user !== c.creator) {
        c.soldByOthers += sol;
      }
      return;
    }
    // CompleteEvent
    const c = coins.get(e.mint);
    if (c !== undefined) c.complete = true;
  }

  function handleFills(fills: Fill[], view: BotLike): void {
    for (const f of fills) {
      if (f.client_id.startsWith('_')) {
        // Harness close (flatten / complete / writeoff): position gone,
        // and the coin is done — never re-enter it (own flow skews the cap).
        held.delete(f.mint);
        selling.delete(f.mint);
        if (fillerInFlight === f.mint) fillerInFlight = null;
        const cc = coins.get(f.mint);
        if (cc !== undefined) cc.done = true;
        continue;
      }
      if (f.status === 'rejected') continue;
      if (f.side === 'sell' && f.status === 'failed') {
        // A failed sell frees the mint for a retry next batch (without
        // this the position would be stuck in `selling` forever) and
        // the failed tx fee still lands in the position's cost basis.
        selling.delete(f.mint);
        const hh = held.get(f.mint);
        if (hh !== undefined) hh.txPaid += BigInt(f.tx_fee_lamports ?? '0');
        continue;
      }
      if (f.side === 'buy' && f.status === 'filled') {
        const paid = BigInt(f.quote_lamports ?? '0');
        if (paid >= params.minBuyLamports) countedMints.add(f.mint);
        const h = held.get(f.mint);
        if (h === undefined) {
          const c = coins.get(f.mint);
          const isFiller = fillerInFlight === f.mint;
          if (isFiller) stats.fillerBuys += 1;
          else stats.mainBuys += 1;
          held.set(f.mint, {
            openedSlot: f.slot ?? view.slot,
            txPaid: BigInt(f.tx_fee_lamports ?? '0'),
            devSoldAtOpen: c !== undefined ? c.devSold : false,
            filler: isFiller,
          });
          if (isFiller) fillerInFlight = null;
        } else {
          h.txPaid += BigInt(f.tx_fee_lamports ?? '0');
        }
      } else if (f.side === 'sell' && f.status === 'filled') {
        selling.delete(f.mint);
        const tokens = BigInt(f.token_amount ?? '0');
        const pos = view.positions.get(f.mint);
        if (pos === undefined || pos.token_amount <= 0n) {
          const h = held.get(f.mint);
          if (h !== undefined && h.filler) stats.fillerTrips += 1;
          held.delete(f.mint);
        }
        const h = held.get(f.mint);
        if (h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports ?? '0');
      }
    }
  }

  function positionValue(mint: string, view: BotLike): bigint {
    const pos = view.positions.get(mint);
    if (pos === undefined || pos.token_amount <= 0n) return 0n;
    const c = view.curves.get(mint);
    if (c === undefined) return 0n;
    return sellValueLamports(pos.token_amount, c.virtual_token_reserves, c.virtual_quote_reserves, view.feeBps, view.txFee);
  }

  function hasPendingBuy(mint: string, view: BotLike): boolean {
    for (const p of view.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(mint: string, view: BotLike): boolean {
    for (const p of view.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  function sellAll(mint: string, view: BotLike, orders: Order[]): boolean {
    const pos = view.positions.get(mint);
    if (pos === undefined || pos.token_amount <= 0n) return false;
    if (selling.has(mint) || hasPendingSell(mint, view)) return false;
    if (orders.length >= view.maxOrdersPerBatch) return false;
    orders.push({
      side: 'sell',
      client_id: view.clientId('s'),
      mint,
      token_amount: pos.token_amount.toString(),
      max_slippage_bps: 10000,
    });
    selling.add(mint);
    return true;
  }

  function decide(view: BotLike, batch: Batch): Order[] {
    const orders: Order[] = [];
    const slot = batch.slot;
    view.slot = slot;

    // Block-time window for the filler pace (data, not the clock).
    for (const e of batch.events) {
      const bt = eventTime(e);
      if (bt > 0) {
        if (firstBlockTime === 0) firstBlockTime = bt;
        lastBlockTime = bt;
      }
      trackEvent(e);
    }
    handleFills(batch.fills, view);

    // --- exits first (main positions and filler positions) ---
    const heldMints = [...held.keys()].sort();
    for (const mint of heldMints) {
      const h = held.get(mint);
      if (h === undefined) continue;
      const pos = view.positions.get(mint);
      if (pos === undefined || pos.token_amount <= 0n) {
        held.delete(mint);
        continue;
      }
      const c = getCoin(mint);
      const curve = view.curves.get(mint);
      if (curve === undefined || curve.complete) {
        // Curve completed or gone: nothing to sell; harness closes it.
        continue;
      }
      const value = positionValue(mint, view);
      const basis = pos.cost_lamports + h.txPaid;
      let exit = false;
      if (h.filler) {
        // Filler: sell on the first batch after the buy filled.
        exit = true;
      } else {
        if (value * BPS >= basis * (BPS + params.tpBps)) exit = true;
        if (value * BPS <= basis * (BPS - params.slBps)) exit = true;
        if (slot - h.openedSlot >= params.maxHold) exit = true;
        if (params.exitOnDevSell && c !== undefined && c.devSold && !h.devSoldAtOpen) exit = true;
      }
      if (exit) {
        if (sellAll(mint, view, orders)) {
          if (c !== undefined) c.done = true;
        }
      }
    }

    // --- main leg: launch sniper entries on coins that traded now ---
    const tradedMints = new Set<string>();
    for (const e of batch.events) if (e.event === 'TradeEvent') tradedMints.add(e.mint);
    const orderedMints = [...tradedMints].sort();
    for (const mint of orderedMints) {
      if (orders.length >= view.maxOrdersPerBatch) break;
      const c = getCoin(mint);
      if (c === undefined || c.done || c.complete) continue;
      const curve = view.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (view.positions.has(mint) || hasPendingBuy(mint, view)) continue;
      if (view.committedPositionCount() >= view.maxPositions) break;
      if (c.buysSent > 0) continue; // one buy per coin
      const age = slot - c.createSlot;
      if (age < params.minAge || age > params.maxAge) continue;
      if (params.skipDevSold && c.devSold) {
        c.done = true;
        continue;
      }
      const realSol = curve.real_quote_reserves;
      if (realSol < params.minRealSol || realSol > params.maxRealSol) continue;
      if (c.devBuy < params.minDevBuy || c.devBuy > params.maxDevBuy) continue;
      if (c.buyers.size < params.minBuyers || c.buyers.size > params.maxBuyers) continue;
      const room = params.stakeLamports - c.spentSent;
      if (room < params.minBuyLamports) continue;
      const cap = view.maxBuyLamports(mint);
      const amount = room < cap ? room : cap;
      if (amount < params.minBuyLamports) continue;
      const free = view.freeCashLamports();
      if (free < amount + view.txFeeLamports() * 6n) continue;
      orders.push({
        side: 'buy',
        client_id: view.clientId('b'),
        mint,
        quote_lamports: amount.toString(),
        max_slippage_bps: params.buySlippageBps,
      });
      c.buysSent += 1;
      c.spentSent += amount;
      c.lastBuySlot = slot;
    }

    // --- filler leg: guardrail pace ---
    if (fillerInFlight === null && orders.length < view.maxOrdersPerBatch) {
      const elapsed = lastBlockTime - firstBlockTime;
      const expected = Math.min(params.fillerTargetMints, Math.floor((params.fillerTargetMints * elapsed) / params.fillerWindowSecs));
      const behind = expected - countedMints.size;
      if (behind >= 2 && view.committedPositionCount() < view.maxPositions) {
        // Pick the hottest liquid coin in this batch: most net buy SOL,
        // real reserves big enough for a 0.01 SOL buy, creator not sold.
        let bestMint: string | null = null;
        let bestScore = 0n;
        const buyVol = new Map<string, bigint>();
        const sellVol = new Map<string, bigint>();
        for (const e of batch.events) {
          if (e.event !== 'TradeEvent') continue;
          const sol = BigInt(e.sol_amount);
          if (e.is_buy) buyVol.set(e.mint, (buyVol.get(e.mint) ?? 0n) + sol);
          else sellVol.set(e.mint, (sellVol.get(e.mint) ?? 0n) + sol);
        }
        for (const mint of [...buyVol.keys()].sort()) {
          const c = getCoin(mint);
          if (c === undefined || c.done || c.complete || c.devSold) continue;
          if (c.buysSent > 0 || fillerSeen.has(mint)) continue; // never re-buy a traded coin
          const curve = view.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (curve.real_quote_reserves < params.fillerMinRealSol) continue;
          // 2x margin on the cap: the harness checks the cap against
          // reserves shifted by our own earlier flow on the coin.
          if (view.maxBuyLamports(mint) < params.fillerBuyLamports * 2n) continue;
          if (view.positions.has(mint) || hasPendingBuy(mint, view)) continue;
          const net = (buyVol.get(mint) ?? 0n) - (sellVol.get(mint) ?? 0n);
          if (net > bestScore) {
            bestScore = net;
            bestMint = mint;
          }
        }
        if (bestMint !== null && bestScore > 0n) {
          const free = view.freeCashLamports();
          const amount = params.fillerBuyLamports;
          if (free >= amount + view.txFeeLamports() * 2n) {
            orders.push({
              side: 'buy',
              client_id: view.clientId('f'),
              mint: bestMint,
              quote_lamports: amount.toString(),
              max_slippage_bps: 10000,
            });
            fillerInFlight = bestMint;
            fillerSeen.add(bestMint);
          }
        }
      }
    }

    return orders;
  }

  return { decide, countedMints, coins, held, stats };
}

// ------------------------------------------------------------------
// Wire loop: NDJSON on stdin/stdout.
// ------------------------------------------------------------------

export function runBot(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
  const view = new BotView();
  const { decide } = createStrategy(DEFAULT_PARAMS);
  let buffer = '';

  const writeLine = (s: string): void => {
    output.write(s + '\n');
  };

  const handle = (line: string): void => {
    if (line.trim().length === 0) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line) as unknown;
    } catch {
      process.stderr.write('bad json line\n');
      return;
    }
    const m = msg as { type?: string };
    if (m.type === 'hello') {
      view.applyHello(msg as Hello);
      return;
    }
    if (m.type === 'batch') {
      const b = msg as Batch;
      view.seq = b.seq;
      view.applyEvents(b.events);
      view.applyMarks(b.marks);
      view.applyAccount(b.account);
      view.applyFills(b.fills);
      const orders = decide(view, b);
      const reply: Reply = { type: 'reply', seq: b.seq, orders };
      writeLine(JSON.stringify(reply));
      // Track the orders we just sent as pending so the next batch
      // sees them (the harness also reports them in fills).
      for (const o of orders) {
        view.pending.set(o.client_id, { client_id: o.client_id, order: o, seq: b.seq, decided_slot: b.slot });
      }
      return;
    }
    if (m.type === 'done') {
      const d = msg as DoneMsg;
      if (d.account !== undefined) view.applyAccount(d.account);
      return;
    }
    process.stderr.write(`unknown message type: ${String(m.type)}\n`);
  };

  return new Promise<void>((resolve) => {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handle(line);
        idx = buffer.indexOf('\n');
      }
    });
    input.on('end', () => {
      if (buffer.trim().length > 0) handle(buffer);
      resolve();
    });
  });
}

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runBot(process.stdin, process.stdout).catch((e: unknown) => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
