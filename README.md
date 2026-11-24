[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/yansz54/pump-anybot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/yansz54/pump-anybot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Pump.fun Paper Sprint — Any Bot Can Win

A deterministic paper-trading bot for pump.fun bonding-curve tokens on a
6-hour replay of real market data. It snipes fresh launches that show
genuine early distribution (exactly two non-creator buyers, small
creator buy), takes profit at +25%, cuts at −12%, and exits after 5
slots. A pace-based filler leg guarantees the 20-mint guardrail even in
a quiet 6-hour window.

`main.ts` (Node 22, stdlib only) speaks the `agent-fun/replay/v2`
protocol over stdin/stdout: one `reply` per `batch`, fully deterministic
— no clock, no randomness, no `Date.now`, no `Math.random`. Two runs on
the same feed produce byte-identical action logs.

See `METHOD.md` for the strategy, the tuning sweeps, and the dev
backtest numbers.

Entry for the make.fun competition
[u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b).
