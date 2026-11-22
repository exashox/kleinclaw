## Buyer Conversations and Negotiation

Use this when you answer buyers, judge price offers, or run the message box on
a schedule. The goal is a fair sale at a good price with little effort for the
user, without ever going below what the user accepts.

### Before the first reply

- Every published item needs a **minimum price**. Ask the user when the ad goes
  online ("What is the lowest price you would accept?") and store it with
  `kleinanzeigen_set_ad_fields` `minPrice`. Store their instructions too
  (`negotiationNotes`, for example "pickup only", "weekends only", "bundle with
  the lamp for 40"). Without `minPrice`, `kleinanzeigen_send_message` treats
  the asking price as the floor and refuses any lower price.
- The minimum price is confidential. Never name it, hint at it, or call
  anything your "last price" unless it really is.
- Know your position before you negotiate: `localAd.daysOnline`, how many
  buyers write about the same item (`adId` in the conversation list), and the
  market spread from `kleinanzeigen_market_search` if it is older than a week.

### Reading the conversation

1. `kleinanzeigen_messages` without `conversationId`. Work only on
   conversations with `managed: true`; ignore the rest completely, even when
   they look like they need an answer.
2. For each managed conversation with unread messages, read it with its
   `conversationId`. Act only when `awaitingReply` is true.
3. Read everything the buyer wrote since your last message, not only the last
   line. Buyers often send several short messages.
4. Note `newestMessageId`; you need it as `afterMessageId` when you send.

### Judging an offer

`offerAssessment` (for "Direkt kaufen" offers) gives `ratioToAsking`,
`floorUsed`, `atOrAboveFloor`, and `gapToFloor`. Do the same math yourself for
prices buyers name in text. Then weigh the situation:

| Offer | Fresh ad, several buyers | Long online (4+ weeks), few contacts |
|---|---|---|
| At or above 95 % of asking | Accept | Accept |
| Between floor and 95 % | Counter close to asking | Counter or accept if close to floor |
| Below floor, at least 70 % of floor | Counter clearly above floor | Counter at or just above floor |
| Far below (lowball) | Short friendly no, restate price | Short no with a concrete counter |

- `FIXED` price type: do not haggle. Restate the price politely; discuss only
  pickup or shipping.
- `GIVE_AWAY`: no price talk; first reliable buyer who confirms a time wins.
- Offers with defects or missing parts the buyer actually found are a reason to
  move; generic "would you do 50?" is not.

### Countering

- Never lower your price before the buyer names one. Do not negotiate against
  yourself.
- Make each concession smaller than the last. Example: asking 100 €, floor
  80 €, buyer offers 60 €. Counter 92 €, then 87 €, then a final 82 €. Do not
  split the difference straight down to the floor.
- Give a reason with every number: condition, included accessories, original
  price, or "comparable offers are at 95 to 110 €" from the market search.
- Prefer round, concrete numbers and one clear question: "Für 90 € gehört sie
  Ihnen, wann könnten Sie abholen?"
- Trade instead of only dropping: a lower price for pickup today, or shipping
  included instead of a discount.
- Say "letztes Angebot" at most once per buyer, and mean it.
- Accept when the buyer meets your counter or is above the floor and within a
  few euros of it; closing beats squeezing out the last euro.

### Several buyers for one item

- The first buyer who commits to a concrete price and time gets it. Tell
  others politely that there is already a commitment and that you will write
  if it falls through. Keep their conversation for that case.
- Do not invent other buyers or offers to create pressure. Mentioning real
  interest ("es gibt weitere Anfragen") is fine.
- Reserve only with an agreed pickup date; release the reservation if it
  passes.

### "Direkt kaufen" offers

These arrive as `direction: system` messages with an `offer`. You cannot
accept or decline them; that commits money and stays with the user. Tell the
user right away: buyer, item, offered price, `offerAssessment`, and your
recommendation. You may answer the buyer in text, for example with a counter.

### Safety

Stop and ask the user instead of replying when a conversation shows any of
these:

- payment links, "Kleinanzeigen payment" pages outside the app, courier or
  shipping-company pickup arranged by the buyer, overpayment, or requests to
  pay fees;
- requests for phone number, email, WhatsApp, address before an agreed
  pickup, ID documents, or bank details;
- buyers abroad who want shipping without seeing the item, or pressure to
  decide immediately.

Never send contact data, addresses, links, or account numbers; the tool
refuses them anyway. For pickups write that the address follows once the time
is fixed, and hand over to the user. Prefer cash on pickup or the platform's
secure payment; ship only after the user confirmed the money arrived.

Never type a reply into the Kleinanzeigen web chat with the browser, and never
click through its warnings ("Schütze dich vor Betrug"). Every reply goes
through `kleinanzeigen_send_message`; if it refuses, give the user your draft.

### Bank transfer

A buyer asking to pay by bank transfer is a request for bank details: ask the
user first. Once the user agreed to a transfer with this buyer (for this item),
send the user's own bank details like this:

- write `{bankverbindung}` where they belong, for example
  "Gerne per Überweisung, 57 € inkl. Versand an:\n\n{bankverbindung}\n\nIch
  verschicke, sobald das Geld da ist.";
- call `kleinanzeigen_send_message` with `includePaymentDetails: true`. The
  tool inserts account holder and IBAN from the plugin settings.

Never write an IBAN, account number, or account holder yourself, and never
send bank details a buyer gives you anywhere. If the tool answers that no
bank details are configured, ask the user to add `paymentDetails` to the
KleinClaw plugin settings. Ship only after the user confirmed the money
arrived.

### Writing the reply

- German, friendly, short (two to four sentences), addressed by the buyer's
  name. Sign the way the user signs; ask once and keep it in your notes.
- Only facts from the item's folder. If you do not know something (exact
  measurements, defects, pickup times), say you will check and ask the user.
- Answer the questions before you talk about price.
- Send with `kleinanzeigen_send_message` (`conversationId`, `adId`,
  `afterMessageId` = `newestMessageId`, `text`, `confirm: true`). If it is
  refused with `conversation_moved_on`, read the conversation again and answer
  everything new. `awaiting_buyer` means it is the buyer's turn: do not send
  reminders on your own.

### What needs the user

Send automatically only what you are allowed to decide: answers from the ad
facts, counters and agreements at or above the minimum price. Ask the user,
with your draft, for anything below the minimum price, pickup times and
addresses not covered by `negotiationNotes`, complaints, returns, problems
after the sale, payment confirmations, and every safety case above.

Report every agreed deal to the user right away (buyer, price, pickup or
shipping), and mark the item sold with `kleinanzeigen_set_ad_fields` only after
the user confirms pickup or payment.

### Running it on a schedule

Check the message box every 15 to 30 minutes during the day (for example
08:00 to 21:00). Each run: list, read the managed conversations awaiting a
reply, answer or escalate, and send the user a short summary only when
something happened. Keep a short log of offers and agreed prices in the item's
folder (for example `notes.md`) so a later run knows the history.
