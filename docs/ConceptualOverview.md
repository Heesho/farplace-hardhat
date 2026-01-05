# Conceptual Overview

## 0) Identity
FarPlace is an art-themed mining game that we built at GlazeCorp. Players compete for short-term control of digital “slots,” earn a stream of FarPlace tokens while they hold a slot, and can later trade those tokens against $DONUT through a liquidity pool. The system routes part of each takeover payment back to DonutDAO’s treasury and contributors, so it directly supports the broader Donut ecosystem while giving people a playful way to engage with it. GlazeCorp designed and maintains the product, but DonutDAO remains the protocol steward and ultimate destination for value.

## 1) The core idea
Think of FarPlace as a set of gallery rooms that anyone can rent. Each room has a price tag that starts high and steadily falls until someone rents it. When you take over a room, you pay the current price: most of that payment goes to the previous renter, and a slice goes to DonutDAO and designated partners. While you hold a room, a token meter quietly ticks upward and mints FarPlace tokens for you. Key concepts:
- **Slots (rooms):** Individual positions that can be held by one person at a time.
- **Falling price clock:** Each slot has a price that decays over a fixed window; acting earlier costs more.
- **Takeover payouts:** When you replace someone, they receive most of what you pay.
- **Emissions meter:** Holding a slot streams tokens to the current holder, with a global pace that halves over time and never fully stops.
- **Random boosts:** Occasionally, a randomness draw assigns a temporary multiplier that speeds up your token meter for a day.
- **Treasury share:** A fixed portion of every paid takeover is diverted to DonutDAO, the core team, and optional community factions.

## 2) Why this exists
Pure token farming can feel abstract. We wanted a clear, story-like loop where people see how their actions support $DONUT while earning a distinct art rig token. Traditional staking or farming often hides fee flows and offers little room for player-versus-player dynamics. FarPlace makes the incentives visible: you pay to oust someone, they get paid, and the protocol takes its cut. The design principle is simple cause and effect—every takeover visibly moves value, and every minute held produces new tokens.

## 3) The cast of characters
- **Slot holders (miners):** Want to earn FarPlace tokens by holding a slot. They risk being replaced at any moment and paying to reclaim a position.
- **Challengers:** People who see a slot price they like and choose to replace the holder. They pay the fee, inherit the slot, and start earning emissions.
- **Treasury and team:** Receive a predictable share of each paid takeover; they want sustained activity.
- **Factions (optional):** Approved community groups that can receive a small slice of each takeover when named by the challenger.
- **Liquidity buyers:** People who hold FarPlace–DONUT liquidity tokens and use them to buy accumulated assets from the auction; they want to capture value routed from slot activity.
- **GlazeCorp:** Builds and maintains the system, sets configuration like approved factions and emission parameters, and hands fee flows to DonutDAO destinations.

## 4) The system loop
1. Each slot has a starting price that falls over a one-hour window until it reaches zero.
2. A challenger pays the current price to take the slot. Most of that payment goes to the prior holder; the rest goes to the treasury, team, and any named faction.
3. The takeover resets the slot’s timer: the next starting price is a multiple of whatever was just paid (with safeguards so it never drops below a small minimum or exceeds a huge maximum).
4. While you hold the slot, your token meter runs at a rate that gradually halves every 30 days and is split across all available slots. A temporary multiplier may apply for roughly a day after a randomness draw.
5. When someone else takes your slot, your accrued tokens are minted to you, and the loop repeats.

## 5) Incentives and value flow
- **Who pays:** A challenger pays with wrapped ether to seize a slot. If the price has already decayed to zero, the takeover is free.
- **Who earns:** The prior holder receives the bulk (typically 80%) of the payment. DonutDAO’s treasury always receives a share; the team and an approved faction can each receive a small slice when applicable.
- **Token flow:** Slot holders earn newly minted FarPlace tokens over time. Emissions per slot shrink as more time passes (halvings) or as more slots are enabled (each slot gets a share).
- **Auction loop:** Wrapped ether collected in the system accumulates and is periodically sold via a separate falling-price sale to people who hold FarPlace–DONUT liquidity tokens. Those buyers pay with their liquidity tokens, which are sent to a burn address, concentrating remaining value for everyone still holding the pool.
- **Why it matters:** Takeovers recycle value to players, route protocol revenue to DonutDAO, and reduce liquidity token supply, all of which aim to strengthen $DONUT’s position while rewarding participation in FarPlace.

## 6) The rules of the system
- **Allowed:** Anyone can challenge a slot while the price window is open and pay the displayed price. Slot holders can be replaced at any time. Approved factions can be credited during a takeover.
- **Discouraged or impossible:** Challenging with a stale epoch ID or past a user-chosen deadline is rejected to prevent frontrunning. Prices cannot exceed a maximum or drop below a protective floor for the next round. Multipliers cannot be set below 1x.
- **Enforced automatically:** Price decay over the fixed window; fee splits; token emissions based on time held; halving schedule; capacity limits; multiplier duration and assignment from randomness; liquidity sale price decay and next-start recalculation.
- **Intentionally open:** We can expand slot capacity, update which factions are recognized, and adjust the set of possible multipliers. Treasury and team destinations can be updated. Governance over these levers can be delegated (the repository includes a timelock pattern but not the full DAO wiring).

## 7) A concrete walkthrough (with numbers)
1. At noon, Slot A’s starting price is 1.0 wrapped ether and will fall linearly to 0 over the next hour.
2. At 12:15, Alex likes the price at 0.75 and takes the slot. Payment splits: 0.60 back to the previous holder (or 0 if none), 0.15 total to DonutDAO, team, and an approved faction.
3. Slot A’s next starting price becomes roughly 1.5 (a 2x multiplier of the paid price, capped by safety limits) and begins decaying again.
4. Alex holds the slot for 30 minutes. During that time, the emission rate is 4 tokens per second divided by the number of slots (say capacity is 2, so 2 tokens/sec here), so Alex accrues about 3,600 tokens. If a random boost of 2x was active for that day, Alex would earn about 7,200 instead.
5. At 12:45, Blair takes over at a decayed price of 0.30. Blair pays; Alex receives about 0.24, DonutDAO and allies get about 0.06, and Alex’s 3,600–7,200 tokens mint to Alex. Slot A resets and the loop continues.

## 8) What this solves (and what it does not)
FarPlace makes value routing transparent: every takeover visibly pays the prior holder and the protocol, and every minute held clearly produces tokens. It adds a game-like cadence to supporting $DONUT’s liquidity while rewarding active participants. This is NOT a guarantee of profit, passive income, or price appreciation. It does not promise future features, cross-chain deployments, or art drops beyond what is visible here. If any aspect is unclear in the code or tests, we call that out rather than speculate.

## 9) Power, incentives, and trust
Control over configuration (like slot capacity, fee recipients, and multipliers) sits with the system owner, which can be put behind a timelock and multisig. Participants trust that these levers are used responsibly and that randomness providers behave honestly. The design reduces trust needs by making most flows automatic: price decay, fee splits, emission math, and liquidity burns happen deterministically once parameters are set. Human decision-making remains in choosing those parameters and in operating any governance that moves ownership.

## 10) What keeps this system honest
- **Rewarded behaviors:** Taking slots early (paying higher prices) routes more to the treasury and prior holders; holding slots longer yields more tokens; providing liquidity lets buyers capture auctioned assets.
- **Discouraged behaviors:** Waiting too long risks losing a slot for free; trying to front-run with stale data is rejected; setting harmful multipliers below 1x is blocked.
- **Selfish actions:** If someone pays to take a slot, most of that payment still benefits the outgoing holder and protocol. If participation slows and prices reach zero, takeovers become free, but emissions continue at the tail rate, and the next starting price stays above a small floor to keep future activity meaningful.
- **Randomness:** Boosts rely on an external randomness feed; challengers must supply the small fee when a new draw is needed. If randomness stalls, slots simply continue at the default multiplier.

## 11) FAQ
1. **What is FarPlace?** An art-themed mining game where you rent short-lived slots to earn FarPlace tokens and support DonutDAO.  
2. **How do I get a slot?** Pay the current falling price shown for a slot; if it has fallen to zero, you can take it for free.  
3. **Where does my payment go?** Most goes to the person you replaced; the rest goes to DonutDAO, the team, and optionally a recognized faction.  
4. **How do I earn tokens?** Hold a slot—tokens accrue each second you control it and mint when someone else replaces you.  
5. **What makes the price change?** Each slot’s price starts high and linearly drops to zero over an hour, then resets based on the last paid amount.  
6. **What if no one takes my slot for a long time?** You keep it and keep accruing tokens; when you are finally replaced, all that time mints to you.  
7. **Why do emissions shrink over time?** The global rate halves every 30 days to create diminishing issuance, but never stops thanks to a small tail rate.  
8. **What is a multiplier boost?** Occasionally, a randomness draw assigns a higher earnings rate for about a day; if none is drawn, earnings stay at the default rate.  
9. **Can there be more slots?** Yes, capacity can be increased, which divides the emission rate across more slots.  
10. **How does this involve $DONUT?** FarPlace tokens pair with $DONUT in a liquidity pool. Auction buyers spend those liquidity tokens to claim accumulated assets, and the liquidity tokens they spend are burned, concentrating remaining value.  
11. **Who can set factions or fee receivers?** The system owner can approve factions and change treasury or team destinations; this can be placed behind governance delays.  
12. **What if randomness fails?** The system defaults to the standard earnings rate; boosts simply stop appearing until randomness resumes.

## 12) Glossary
- **Slot:** A single rentable position in the mining game. Only one holder at a time.  
- **Challenger:** Someone paying to take over a slot.  
- **Holder:** The current controller of a slot who is earning tokens.  
- **Falling price:** A price that starts high and drops linearly to zero over a set hour.  
- **Takeover:** The act of paying the current price to replace the holder.  
- **Treasury share:** The portion of each paid takeover routed to DonutDAO and related addresses.  
- **Team share:** A small portion of each takeover reserved for the core builders when configured.  
- **Faction:** An approved community recipient that can be named to receive a slice of a takeover.  
- **Emissions:** The ongoing creation of FarPlace tokens while a slot is held.  
- **Halving:** A scheduled 50% reduction in the global emission rate every 30 days.  
- **Tail rate:** The minimum emission pace that persists even after many halvings.  
- **Multiplier:** A temporary boost factor that can speed up emissions for about a day.  
- **Randomness fee:** A small payment needed to request a new multiplier draw when the previous one has expired.  
- **Capacity:** The number of slots available; raising it spreads emissions across more holders.  
- **Liquidity pool token:** A receipt representing a share of the FarPlace–$DONUT pool. Used to buy accumulated assets in the auction.  
- **Auction:** A separate falling-price sale where liquidity pool tokens are spent to claim the system’s collected assets, and the spent tokens are burned.  
- **Burn:** Sending tokens to an unrecoverable address, shrinking supply.  
- **Deadline:** A user-chosen cutoff time after which a takeover or purchase is rejected to avoid being front-run.  
- **Epoch:** A single price window for a slot or an auction round before it resets.  
- **Wrapped ether:** The payment token used for takeovers; standard ether deposited into a token format.  
- **FarPlace token:** The reward token minted for slot holders.  
- **$DONUT:** The broader ecosystem token that FarPlace pairs with in the liquidity pool.
