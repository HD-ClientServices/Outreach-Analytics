-- Outreach Analytics — seed for sms_analytics.context_docs
-- Exported read-only from HappyDebt Platform (ouszjnrkawvrwxjjgrxx) on 2026-07-20,
-- BEFORE the surgical revert, so it can be restored into the NEW dedicated project.
-- Note: apostrophes were cleaned ('' -> ') vs the original stored value.
--
-- config captured (non-secret):
--   ghl_location = 'NXZFG9aQz6r1UXzZoedy'
--   gen_model    = (was not set; edge function defaults to 'claude-sonnet-5')
-- Secrets NOT exported — re-enter these in the new project's Table Editor:
--   ghl_api_key       (the GHL read-only API token)
--   anthropic_api_key (for the Generator)
--   dash_token        (ROTATE — pick a fresh value)

insert into sms_analytics.context_docs(key, md, updated_at) values
('persona', $persona$# BUYER PERSONA — "The drowning operator" (from 66 closed-won live-transfer calls)
meta:
  source: 66 closed-won MCA debt-settlement deals (call transcripts + AI analysis)
  aggregate: true (anonymous, no client names)
  refresh: every 3 weeks (Sunday)

## persona.firmographics [item: who]
data:
  - Owner-operator of a physical, cash-intensive business, 5-30 years old; healthy but drowning in debt, NOT bankrupt.
  - Industries: ~55% trades/contractors, ~15% transport/auto, ~13% food/retail, ~14% health/services. Almost zero e-commerce/office.
  - Debt: median $111k (range $20k-$520k); ~9 of 10 are stacked in 2-6 MCAs.
  - Mindset: thinks in "$X per week/day", never APR; naive about MCAs ("didn't know the rate was 56%").
  - Geography: all over the US (South / Sun Belt heavy); ~1 in 6 handled in Spanish.
copy_signal: Speak to a real operator, not a "debtor". Lead with weekly/daily payment relief and stacking, never APR/terms.

## persona.pain_context [item: what hurts + why they pick up]
data:
  - The pain: a daily/weekly payment ($3k-$20k/wk, some pay $5,000/day) strangling cash flow. Their words: "money in the front door, out the back door."
  - Stacking: ~9/10 stacked ("borrowing to pay the other"). Current but drowning; caught before default.
  - Origin: took the MCA defensively (bridge a gap, slow season, payroll), almost never for luxury.
  - Trigger to answer: pain gets acute — an unpayable debit, a UCC lien or lawsuit, or already burned by a prior broker (~1 in 3).
copy_signal: Open on the acute trigger (the debit they can't cover, the lien, the harassment). Acknowledge they may have been burned before.

## persona.buying_drivers [item: what motivates the settlement]
data:
  - Relief now (the #1 driver): a payment they can afford; they close on hearing the new number.
  - Legal protection: stop the harassment, lawsuits and liens; attorneys on their side.
  - Get unstuck: escape the trap and unblock real credit (an SBA, a line).
  - Fairness: pay what's fair, not the predatory rate or inflated fees.
  - The key truth: they WANT to pay ("I'm not running from it"). Winning angle = restructure, not erase: one payment 50-70% lower + attorneys who shield them.
copy_signal: Frame as "you'll still pay your debt — just at a payment you can actually handle." Never imply debt erasure/evasion.

## persona.objections [item: objection -> what disarms it] (gold for copy)
data:
  - "Is this different from the one that already scammed me?" (MOST COMMON) -> Attorney-led from the start; we do this daily with your same lenders and cut the junk fees, nothing paid upfront.
  - "Will they keep harassing / sue me?" -> Power of attorney takes over all comms; the new agreement supersedes; we handle UCC/COJ.
  - "Do I have to pay upfront?" -> No upfront (or just $500 to open escrow); the fee is baked into the reduced payment.
  - "What about my credit? I don't want another MCA." -> It's not a loan or consolidation, it's restructuring; MCAs don't report to credit.
  - "Let me think / talk to my partner." -> Anchor to the next debit: "we stop tomorrow's draft." Weakest point of the close.
copy_signal: Pre-empt distrust in the first 1-2 SMS: attorney-led, no upfront, we know your lenders. This is the #1 blocker.

## persona.voice [item: their words + metrics they watch]
data:
  - Talks money in $/week or $/day, never APR. Wants "one monthly payment."
  - Names their lenders (OnDeck, Forward, Rapid...); "we know those" builds instant trust.
  - Metrics watched: the weekly/daily payment amount and the % reduction; not the term or the rate.
  - Verbatims: "it's killing me" / "strangling my working capital" / "borrowing from Peter to pay Paul" / "I'm not running from it" / "I'm the one that got it, I wanna pay it".
copy_signal: Mirror these exact phrases. Quantify in weekly $ and % reduction. Reference known lenders by name.
$persona$, now()),
('brandvoice', $brandvoice$# BRAND VOICE — Settlegroup (MCA debt-restructuring)
meta:
  source: brand "Additional Information" fields (GHL) — editable
  sender_name_in_current_sms: "Settlegroup" (reps sign as {opener}, e.g. Anna)

## brand.target_audience [item: who we speak to]
data: Small business owners in the U.S. struggling with Merchant Cash Advance (MCA) debt — restaurants, auto repair shops, local retail stores, salons, small service providers.

## brand.pain_points [item: challenges we solve]
data: Daily/weekly high-cost MCA payments creating financial stress; lack of access to affordable funding alternatives; risk of damaging credit or losing business stability.

## brand.promise [item: the promise]
data: Save your business by eliminating the toxic debt and helping you access the conventional banking system.

## brand.what_we_do [item: core function]
data: We consolidate all your MCA positions into a single affordable weekly or monthly remittance, with up to 70% relief. 10+ years doing this.

## brand.differentiator [item: why choose us]
data: 10+ years of experience with results that speak for themselves; real people genuinely committed to helping every step of the way, backed by strong, reliable legal support.

## brand.values [item: non-negotiables]
data: Oppose predatory lending and hidden fees; no pressure, no upfront costs, always confidential; empathy first — we understand the stress of financial struggles.

## brand.risks_of_inaction [item: urgency]
data: Continued daily/weekly payments draining cash flow; business instability or bankruptcy; missed opportunity to negotiate debt forgiveness.

## brand.claims_guardrails [item: compliance / allowed claims]
data:
  - Allowed: "up to 70% relief / lower payment", "attorney-led", "no upfront cost (or $500 escrow)", "we know your lenders", "10+ years".
  - Avoid: promising debt erasure/evasion, guaranteed outcomes, a hard % without "up to", credit-repair claims.
  - A2P 10DLC: identify the sender, stay truthful, and offer opt-out (Reply STOP) on the FIRST message of a sequence.
$brandvoice$, now())
on conflict (key) do update set md = excluded.md, updated_at = now();
