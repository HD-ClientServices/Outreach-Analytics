-- Arranque de la persona de MCA: el contenido curado a mano que hasta ahora vivía
-- hardcodeado en dashboard/index.html, volcado a la misma forma que produce
-- persona_build.
--
-- No es decoración: es lo que le permite al dashboard tener UN SOLO camino de
-- render. Sin esto, la vertical que todavía no corrió su generación necesitaría
-- un caso especial en el front. Y `source.label` dice de dónde salió
-- ("hand-analysed"), así que no se hace pasar por generado.
--
-- La primera corrida real de persona_build lo reemplaza (is_current -> false).

insert into sms_analytics.persona_doc(persona_key,n_calls,n_opps,n_words,pipelines,doc,md,model,is_current)
values ('mca', 67, 67, null,
  '[{"id":"xXSPcEgGwRNwxndym0c7","name":"RISE CLOSING"},{"id":"AMMYRDoaZAGs6zXocz0V","name":"NCN CLOSING"}]'::jsonb,
  $doc${"version": 1, "personaKey": "mca", "label": "MCA", "headline": "The drowning operator", "confidence": "high", "caveats": [], "thin": false, "source": {"key": "manual", "label": "hand-analysed closer calls (pre-pipeline)"}, "sample": {"deals": 67, "pipelines": ["RISE CLOSING", "NCN CLOSING"], "spanishShare": 16.0, "debtMedian": 111000, "paymentMedian": null}, "sections": [{"id": "firmographics", "lines": [{"label": "Profile", "text": "Owner-operator of a physical, cash-intensive business, 5 to 30 years old; healthy but drowning in debt, not bankrupt \u2014 **9 in 10 (90%)** run this kind of brick-and-mortar operation.", "evidenceN": null}, {"label": "Industries", "text": "55% trades/contractors, 15% transport/auto, 13% food/retail, 14% health/services. Almost zero e-commerce.", "evidenceN": null}, {"label": "Debt", "text": "Median of **$111k** (range $20k to $520k); 9 of 10 are stacked in 2 to 6 MCAs.", "evidenceN": null}, {"label": "Mindset", "text": "Thinks in dollars per week or per day, never in APR \u2014 **91%** frame the debt that way; naive about MCAs (\"didn't know the rate was 56%\").", "evidenceN": null}, {"label": "Geography", "text": "Spread across the US, weighted to the South and the Sun Belt; **1 in 6** is handled in Spanish.", "evidenceN": null}], "copySignal": "Speak to a real operator, not a 'debtor'. Lead with weekly relief and stacking, never APR."}, {"id": "pain_context", "lines": [{"label": "The pain", "text": "A daily or weekly payment ($3k to $20k per week, some pay $5,000 a day) that strangles their cash flow \u2014 **82%** describe it just like that. In their words: \"money in the front door, out the back door\".", "evidenceN": null}, {"label": "Stacking", "text": "**9 of 10** are stacked (\"I borrow one to pay the other\"). Current but drowning; the firm catches them before default.", "evidenceN": null}, {"label": "Origin", "text": "They took the MCA defensively (to bridge a gap, a slow season, payroll), rarely for luxury; **45%** give a defensive reason outright on the call.", "evidenceN": null}, {"label": "Trigger", "text": "They answer the call when the pain gets acute \u2014 **2 in 3 (66%)** surface one on the call: an unpayable debit, a UCC lien or a lawsuit; and 1 in 3 were already burned by a prior broker.", "evidenceN": null}], "copySignal": "Open on the acute trigger (the debit they can't cover, the lien, the harassment). Acknowledge they may have been burned before."}, {"id": "buying_drivers", "lines": [{"label": "Relief now", "text": "The main driver \u2014 the affordable payment is the pull in **90%** of won deals. They close on hearing the new number (\"that one I can pay without sweating\").", "evidenceN": null}, {"label": "Legal protection", "text": "Stop the harassment, the lawsuits and the liens, with attorneys on their side \u2014 **24%** ask for it directly.", "evidenceN": null}, {"label": "Get unstuck", "text": "Escape the trap and unblock real credit (an SBA, a line) \u2014 a driver for **12%**.", "evidenceN": null}, {"label": "Fairness", "text": "Pay what's fair, not the predatory rate or the inflated fees.", "evidenceN": null}, {"label": "The key", "text": "They want to pay (\"I'm not running from it\") \u2014 **1 in 2 (48%)** say it outright. The angle that closes is **restructure, not erase**: a payment 50 to 70% lower and attorneys who shield them.", "evidenceN": null}], "copySignal": "Frame it as 'you'll still pay what you owe \u2014 just at an amount you can actually handle'. Never imply erasure or evasion."}, {"id": "objections", "lines": [{"label": "\"Is this different from the one that already scammed me?\"", "text": "Raised in **25%** of calls \u2192 We're attorney-led from the start; we do this daily with their same lenders and cut the fees, charging nothing upfront.", "evidenceN": null}, {"label": "\"Will they keep harassing me or sue me?\"", "text": "**24%** \u2192 With power of attorney we take over all communication, the new agreement supersedes the original, and we handle the UCC/COJ.", "evidenceN": null}, {"label": "\"Do I have to pay upfront?\"", "text": "**31%** \u2192 No upfront (or just $500 to open escrow); the fee is already baked into the reduced payment.", "evidenceN": null}, {"label": "\"What about my credit? I don't want another MCA.\"", "text": "**13%** \u2192 It's not a loan or a consolidation, it's restructuring; MCAs don't report to credit.", "evidenceN": null}, {"label": "\"Let me think about it or talk to my partner.\"", "text": "**22%** \u2192 Anchor to the next debit: \"we stop tomorrow's draft.\" It's the weakest point of the close.", "evidenceN": null}], "copySignal": "Pre-empt the distrust objection in the first 1-2 SMS: attorney-led, nothing upfront, we know their situation. It is the number-one blocker."}, {"id": "voice", "lines": [{"label": "Talks money like this", "text": "In dollars per week or per day, never in APR \u2014 **91%** of them. Wants \"one single monthly payment\".", "evidenceN": null}, {"label": "Names their lenders", "text": "**88%** name them \u2014 OnDeck, Forward, Rapid\u2026 Saying \"we know those\" builds instant trust.", "evidenceN": null}, {"label": "Metrics they watch", "text": "The weekly or daily payment amount and the % reduction; not the term or the rate.", "evidenceN": null}, {"label": "Their phrases", "text": "\"It's killing me\" \u00b7 \"strangling my working capital\" \u00b7 \"borrowing from Peter to pay Paul\" \u00b7 \"I'm not running from it\" \u00b7 \"I'm the one that got it, I wanna pay it\".", "evidenceN": null}], "copySignal": "Mirror these exact phrases. Quantify in weekly dollars and % reduction. Reference known lenders by name."}]}$doc$::jsonb,
  $md$# BUYER PERSONA — "The drowning operator" (from 66 closed-won live-transfer calls)
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
$md$,
  'hand-written', true);
